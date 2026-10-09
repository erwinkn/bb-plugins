import { describe, expect, it, vi } from "vitest";
import { projectFixture } from "./fake-native";
import { sendWrite, WriteUnconfirmedError, WRITE_UNCONFIRMED_MS } from "../lib/write-timeout";

// W244: the fixes for W242's review (A421) of W239's dashboard writes. Its memory fixes moved to
// the Chat memory plugin with T145.
describe("W244 a write sent again after a lost answer runs once", () => {
  it("the server answers a repeated key with the first run's answer, even while the first is still queued", async () => {
    const { f, project } = await projectFixture();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    f.intercept(async (path, _args, call) => {
      if (path === "threads.spawn") {
        reached();
        await gate;
      }
      return call();
    });
    // A delegate holds the write queue, as a slow native spawn does.
    const slow = f.harness.callRpc("command", { projectId: project.id, command: { action: "delegate", label: "Search", area: "search", note: "Do it." } });
    await atGate;
    const command = { action: "task-create", title: "Single intended task", summary: "Create once" } as const;
    // The first send's answer is lost; the user sends the same again with its key.
    const first = f.harness.callRpc("command", { projectId: project.id, command, key: "add-task-1" });
    const again = f.harness.callRpc("command", { projectId: project.id, command, key: "add-task-1" });
    release();
    await slow;
    const [a, b] = await Promise.all([first, again]);
    expect(b).toEqual(a);
    expect(f.store.tasks(project.id).map((t) => t.title)).toEqual(["Single intended task"]);
    // Once done, a repeat still gets the same answer and creates nothing.
    expect(await f.harness.callRpc("command", { projectId: project.id, command, key: "add-task-1" })).toEqual(a);
    expect(f.store.tasks(project.id)).toHaveLength(1);
    // Without a key, or with a new one, the same command runs again: that is the user's intent.
    await f.harness.callRpc("command", { projectId: project.id, command, key: "add-task-2" });
    expect(f.store.tasks(project.id)).toHaveLength(2);
    f.intercept();
  });

  it("the client keeps a keyed write's key for the same content only, until an answer settles it", async () => {
    vi.useFakeTimers();
    try {
      const keys: (string | undefined)[] = [];
      const never = ({ key }: { key?: string }) => { keys.push(key); return new Promise<never>(() => {}); };
      const answer = ({ key }: { key?: string }) => { keys.push(key); return Promise.resolve({ write: "done", answer: "ok" }); };
      const task = { projectId: "p", command: { action: "task-create", title: "A" } };
      const lost = expect(sendWrite(task, never)).rejects.toBeInstanceOf(WriteUnconfirmedError);
      await vi.advanceTimersByTimeAsync(WRITE_UNCONFIRMED_MS);
      await lost;
      // The same content again: the same key, so the server runs it once.
      expect(await sendWrite(task, answer)).toBe("ok");
      expect(keys[1]).toBe(keys[0]);
      // Answered, so the next send of it is a new write with a new key.
      await sendWrite(task, answer);
      expect(keys[2]).not.toBe(keys[0]);
      // Different content is a different write.
      await sendWrite({ projectId: "p", command: { action: "task-create", title: "B" } }, answer);
      expect(new Set(keys).size).toBe(3);
      // W248: a refusal the server answers settles the key; the next send is a new write.
      await expect(sendWrite(task, async ({ key }) => { keys.push(key); return { write: "rejected", message: "no" }; })).rejects.toThrow("no");
      await sendWrite(task, answer);
      expect(keys.at(-1)).not.toBe(keys.at(-2));
    } finally {
      vi.useRealTimers();
    }
  });
});
