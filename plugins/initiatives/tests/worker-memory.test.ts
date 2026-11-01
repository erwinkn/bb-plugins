import { describe, it, expect, vi } from "vitest";
import { createWorkerMemory, workerMemoryKey } from "../lib/memory-scopes";
import type { Sdk } from "../lib/bb";
import type { WorkerRecord } from "../lib/store";
const worker = (num = 1, providerId = "claude-code") => ({ projectId: "p", num, ref: `W${num}`, threadId: `t${num}`, providerId, role: "work", state: "active" }) as WorkerRecord;
function setup() {
  const scopes = new Map<string, string>();
  const rpc = vi.fn(async ({ method, input }: any) => {
    if (method === "attach") { const scope = `initiatives:${input.key}`; scopes.set(input.threadId, scope); return { scope }; }
    const id = scopes.get(input.threadId);
    return id ? { scope: { id, owner: "initiatives" }, mode: "optchat" } : null;
  });
  return { scopes, rpc, memory: createWorkerMemory({ plugins: { callRpc: rpc } } as unknown as Sdk) };
}
describe("private worker UniiChat", () => {
  it("attaches two existing workers separately, proves mode, and coalesces concurrent use", async () => {
    const { memory, scopes, rpc } = setup();
    expect(await Promise.all([memory.ensure(worker()), memory.ensure(worker()), memory.ensure(worker(2))])).toEqual([true, true, true]);
    expect(scopes).toEqual(new Map([["t1", "initiatives:p:worker:1"], ["t2", "initiatives:p:worker:2"]]));
    expect(rpc.mock.calls.filter(([a]) => a.method === "attach")).toHaveLength(2);
    await memory.ensure(worker());
    expect(rpc.mock.calls.filter(([a]) => a.method === "attach")).toHaveLength(2);
    expect(workerMemoryKey(worker())).toBe("p:worker:1");
  });
  it("keeps identity across provider sessions and generations", async () => {
    const { memory, scopes } = setup();
    await memory.ensure(worker());
    await memory.ensure({ ...worker(), threadId: "successor", generation: 2 });
    expect(scopes.get("successor")).toBe(scopes.get("t1"));
  });
  it("does not enroll Codex, reviewers, retired workers or missing native threads", async () => {
    const { memory, rpc } = setup();
    for (const w of [worker(1, "codex"), { ...worker(), role: "review" }, { ...worker(), state: "retired" }, { ...worker(), threadId: null }])
      expect(await memory.ensure(w as WorkerRecord)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("never infers confirmed optchat from attachment, provider or expected metadata", async () => {
    const { memory, rpc } = setup();
    rpc.mockImplementation(async ({ method, input }: any) => method === "attach" ? { scope: `initiatives:${input.key}` } : { scope: { id: "initiatives:coordinator", owner: "initiatives" }, mode: "optchat" });
    await expect(memory.ensure(worker())).rejects.toThrow(/confirm/);
    expect(memory.state(worker())).toMatch(/not confirmed/);
    expect(rpc.mock.calls.filter(([a]) => a.method === "attach")).toHaveLength(0);
  });
  it("reconstructs confirmation after restart without reattaching persisted history", async () => {
    const { memory, rpc } = setup();
    await memory.ensure(worker());
    const restarted = createWorkerMemory({ plugins: { callRpc: rpc } } as unknown as Sdk);
    expect(restarted.state(worker())).toContain("not confirmed");
    expect(await restarted.ensure(worker())).toBe(true);
    expect(rpc.mock.calls.filter(([a]) => a.method === "attach")).toHaveLength(1);
  });
  it("blocks an unacknowledged attach and confirms neither identity nor readiness", async () => {
    const { memory, rpc } = setup();
    rpc.mockImplementation(async ({ method }: any) => {
      if (method === "attach") throw new Error("attach rejected");
      return null;
    });
    await expect(memory.ensure(worker())).rejects.toThrow("attach rejected");
    expect(memory.ready(worker())).toBe(false);
  });
  it("keeps regular mode on the legacy cold guard", async () => {
    const { memory, scopes, rpc } = setup();
    scopes.set("t1", "initiatives:p:worker:1");
    rpc.mockResolvedValue({ scope: { id: "initiatives:p:worker:1", owner: "initiatives" }, mode: "regular" });
    expect(await memory.ensure(worker())).toBe(false);
  });
  it("reports attach failure and permits an explicit retry", async () => {
    const { memory, rpc } = setup();
    rpc.mockRejectedValueOnce(new Error("offline"));
    await expect(memory.ensure(worker())).rejects.toThrow(/UniiChat.*offline/);
    expect(memory.state(worker())).toContain("offline");
    expect(await memory.ensure(worker())).toBe(true);
  });
});
