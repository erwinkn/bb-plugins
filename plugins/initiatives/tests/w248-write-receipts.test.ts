import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, projectFixture } from "./fake-native";
import plugin from "../server";
import { ProjectError } from "../lib/bb";
import { KEY_REUSED_MESSAGE, WRITE_RECEIPT_KEEP_MS, WriteReceipts } from "../lib/write-receipts";
import { sendWrite, WRITE_EXPIRED_MESSAGE, WRITE_RECEIPT_MS, WRITE_UNCONFIRMED_MS } from "../lib/write-timeout";

// W248: the fixes for W246's re-review (A425) of the W239/W244 write keys.
afterEach(() => vi.useRealTimers());

type Fx = Awaited<ReturnType<typeof projectFixture>>;
type Send = (keyed: { key?: string }) => Promise<unknown>;
const addTask = (title: string) => ({ action: "task-create", title, summary: "Create once" });
/** The dashboard's send of a command through the real command RPC. */
const rpc = (f: Fx["f"], projectId: string, command: Record<string, unknown> & { action: string }, keys: (string | undefined)[] = []): Send =>
  (keyed) => {
    keys.push(keyed.key);
    return f.harness.callRpc("command", { projectId, command, ...keyed } as never);
  };
/** A send that reaches the server but whose answer never comes back. */
const lostAnswer = (send: Send): Send => async (keyed) => {
  await send(keyed);
  return new Promise<never>(() => {});
};

describe("W248 a key stays until an answer settles it (A425 finding 1)", () => {
  it("a connection error after the server saved keeps the key, so sending again creates one task", async () => {
    const { f, project } = await projectFixture();
    const keys: (string | undefined)[] = [];
    const send = rpc(f, project.id, addTask("One task"), keys);
    await expect(sendWrite({ projectId: project.id, command: addTask("One task") }, async (keyed) => {
      await send(keyed);
      throw new Error("Connection closed before reply");
    })).rejects.toThrow("Connection closed");
    const again = await sendWrite<{ ref: string }>({ projectId: project.id, command: addTask("One task") }, send);
    expect(keys[1]).toBe(keys[0]);
    expect(f.store.tasks(project.id).map((t) => t.ref)).toEqual([again.ref]);
  });

  it("a refusal that saved nothing releases the key; an unknown failure keeps it until the server says to check", async () => {
    const { f, project } = await projectFixture();
    // Refused before anything was written: a structured rejection, so the next send is new.
    const keys: (string | undefined)[] = [];
    const gone = { projectId: "missing", command: addTask("Nowhere") };
    await expect(sendWrite(gone, rpc(f, "missing", addTask("Nowhere"), keys))).rejects.toThrow("Unknown Initiative missing.");
    await expect(sendWrite(gone, rpc(f, "missing", addTask("Nowhere"), keys))).rejects.toThrow("Unknown Initiative missing.");
    expect(keys[1]).not.toBe(keys[0]);
    // A failure the server cannot vouch for: a plain error, or a refusal after a write. The
    // first send throws as is and keeps its key; the second learns that what it saved is
    // unknown, which settles the key; the third is a new write.
    const changes = () => (f.store.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const receipts = new WriteReceipts(f.store.db, changes);
    const failures: [string, () => Promise<never>][] = [
      ["Native spawn failed", async () => { throw new Error("Native spawn failed"); }],
      ["Refused after saving", async () => {
        f.store.db.prepare("INSERT INTO plugin_flags (key, set_at) VALUES ('w248-test', 0)").run();
        throw new ProjectError("Refused after saving");
      }],
    ];
    for (const [message, fail] of failures) {
      const request = { projectId: project.id, command: addTask(message) };
      const failingKeys: (string | undefined)[] = [];
      const send = (write: () => Promise<unknown>): Send => ({ key }) => {
        failingKeys.push(key);
        return receipts.run(key!, request, write);
      };
      await expect(sendWrite(request, send(fail))).rejects.toThrow(message);
      await expect(sendWrite(request, send(fail))).rejects.toThrow(/unclear what this saved: check the Initiative/);
      expect(failingKeys[1]).toBe(failingKeys[0]);
      expect(await sendWrite(request, send(async () => "saved"))).toBe("saved");
      expect(failingKeys[2]).not.toBe(failingKeys[0]);
    }
  });
});

describe("W248 receipts outlast every retry the client allows (A425 finding 2)", () => {
  it("a key sent again just inside 7 days runs once; past 7 days the client asks to check instead of sending", async () => {
    vi.useFakeTimers();
    const { f, project } = await projectFixture();
    const request = { projectId: project.id, command: addTask("Week-old task") };
    const keys: (string | undefined)[] = [];
    const send = rpc(f, project.id, request.command, keys);
    try {
      const lost = expect(sendWrite(request, lostAnswer(send))).rejects.toThrow("No answer");
      await vi.advanceTimersByTimeAsync(WRITE_UNCONFIRMED_MS);
      await lost;
      await vi.advanceTimersByTimeAsync(WRITE_RECEIPT_MS - WRITE_UNCONFIRMED_MS - 60_000);
      await sendWrite(request, send);
      expect(keys[1]).toBe(keys[0]);
      expect(f.store.tasks(project.id)).toHaveLength(1);

      // Another lost send, then over 7 days of silence: no silent rerun.
      const later = { projectId: project.id, command: addTask("Forgotten task") };
      const laterKeys: (string | undefined)[] = [];
      const laterSend = rpc(f, project.id, later.command, laterKeys);
      const lostAgain = expect(sendWrite(later, lostAnswer(laterSend))).rejects.toThrow("No answer");
      await vi.advanceTimersByTimeAsync(WRITE_UNCONFIRMED_MS);
      await lostAgain;
      await vi.advanceTimersByTimeAsync(WRITE_RECEIPT_MS);
      await expect(sendWrite(later, laterSend)).rejects.toThrow(WRITE_EXPIRED_MESSAGE);
      expect(laterKeys).toHaveLength(1);
      // Once told, the user's next send is a new write.
      await sendWrite(later, laterSend);
      expect(laterKeys[1]).not.toBe(laterKeys[0]);
      expect(f.store.tasks(project.id).map((t) => t.title)).toEqual(["Week-old task", "Forgotten task", "Forgotten task"]);
    } finally {
      vi.useRealTimers();
      }
  });

  it("the server keeps a receipt a day past the client's window, then forgets it", async () => {
    vi.useFakeTimers();
    const { f, project } = await projectFixture();
    const input = { projectId: project.id, key: "kept-key", command: addTask("Kept") };
    try {
      const first = await f.harness.callRpc("command", input as never);
      await vi.advanceTimersByTimeAsync(WRITE_RECEIPT_KEEP_MS - 60_000);
      expect(await f.harness.callRpc("command", input as never)).toEqual(first);
      expect(f.store.tasks(project.id)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(120_000);
      await f.harness.callRpc("command", input as never);
      expect(f.store.tasks(project.id)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      }
  });

  it("a plugin reload keeps the receipts: the same key after it creates nothing more", async () => {
    const f = fixture();
    const { project } = await f.create();
    const input = { projectId: project.id, key: "reload-key", command: addTask("Before reload") };
    const first = await f.harness.callRpc("command", input as never);
    let again!: ReturnType<typeof plugin>;
    const host = await f.harness.reload((bb) => {
      again = plugin(bb);
    });
    try {
      expect(await host.harness.callRpc("command", input as never)).toEqual(first);
      expect(again.store.tasks(project.id)).toHaveLength(1);
    } finally {
      await host.harness.dispose();
    }
  });
});

describe("W248 a value set again is just set (A425 finding 3)", () => {
  it("paused true, false, true each run, and setting commands carry no key", async () => {
    const { f, project } = await projectFixture();
    const keys: (string | undefined)[] = [];
    for (const paused of [true, false, true])
      await sendWrite({ projectId: project.id, command: { action: "pause", paused } }, rpc(f, project.id, { action: "pause", paused }, keys));
    expect(f.store.project(project.id)!.paused).toBe(true);
    expect(keys.every((k) => k === undefined)).toBe(true);
  });
});

describe("W248 a key belongs to one request (A425 finding 5)", () => {
  it("the same key with another Initiative or another payload is refused, and nothing is replayed or skipped silently", async () => {
    const { f, project } = await projectFixture();
    f.store.createProject({ id: "other", name: "Other", objective: "test", memberProjectIds: [], coordinatorThreadId: null });
    const first = await f.harness.callRpc("command", { projectId: project.id, key: "shared", command: addTask("A") } as never);
    expect(first).toMatchObject({ write: "done" });
    const otherProject = await f.harness.callRpc("command", { projectId: "other", key: "shared", command: addTask("A") } as never);
    expect(otherProject).toEqual({ write: "rejected", message: KEY_REUSED_MESSAGE });
    const otherPayload = await f.harness.callRpc("command", { projectId: project.id, key: "shared", command: addTask("B") } as never);
    expect(otherPayload).toEqual({ write: "rejected", message: KEY_REUSED_MESSAGE });
    expect(f.store.tasks("other")).toHaveLength(0);
    expect(f.store.tasks(project.id).map((t) => t.title)).toEqual(["A"]);
    // The same request in another key order is the same request.
    const reordered = { summary: "Create once", title: "A", action: "task-create" };
    expect(await f.harness.callRpc("command", { projectId: project.id, key: "shared", command: reordered } as never)).toEqual(first);
  });
});

// W248 follow-up: W251's review (A429).
describe("W248 follow-up: keys only where a repeat could add something (A429)", () => {
  it("Okay on a decision carries no key; Not okay, which messages the coordinator, does", async () => {
    const keys: (string | undefined)[] = [];
    const send = async ({ key }: { key?: string }) => { keys.push(key); return key ? { write: "done", answer: null } : null; };
    await sendWrite({ projectId: "p", command: { action: "decision-review", decision: "D1", verdict: "okay", message: "" } }, send);
    await sendWrite({ projectId: "p", command: { action: "decision-review", decision: "D1", verdict: "not-okay", message: "Redo it" } }, send);
    expect(keys[0]).toBeUndefined();
    expect(keys[1]).toEqual(expect.any(String));
  });
});

describe("W248 follow-up: storage that refuses to keep a key (A429)", () => {
  it("the page's memory keeps it for the next send, and an answer clears it", async () => {
    const old = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => {} },
    });
    try {
      const { f, project } = await projectFixture();
      const request = { projectId: project.id, command: addTask("Quota") };
      const keys: (string | undefined)[] = [];
      const send = rpc(f, project.id, request.command, keys);
      await expect(sendWrite(request, async (keyed) => { await send(keyed); throw new Error("Connection closed"); })).rejects.toThrow("Connection closed");
      await sendWrite(request, send);
      expect(keys[1]).toBe(keys[0]);
      expect(f.store.tasks(project.id)).toHaveLength(1);
      // Answered: the next send is a new write.
      await sendWrite(request, send);
      expect(keys[2]).not.toBe(keys[0]);
      } finally {
      if (old) Object.defineProperty(globalThis, "localStorage", old);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});
