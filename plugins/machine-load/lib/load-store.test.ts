import { describe, expect, it, vi } from "vitest";
import type { HistoryPoint, LoadResult } from "./contract.js";
import { createLoadStore } from "./load-store.js";

const NOW = Date.now();

/** A point `t` milliseconds into the test, inside the 30-minute window. */
function point(t: number): HistoryPoint {
  return { t: NOW + t, cpu: 1, memory: 1, diskRead: null, diskWrite: null, netReceive: null, netSend: null };
}

function answer(machineId: string, history: HistoryPoint[]): LoadResult {
  return {
    machines: [{ id: "local", name: "Local", connected: true, primary: true }],
    machineId,
    sample: null,
    history,
    error: null,
    settings: { refreshMs: 3000, warningPercent: 80, criticalPercent: 95 },
  };
}

function storeWith(...answers: LoadResult[]) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: answers.shift() })));
  const store = createLoadStore(fetchImpl as unknown as typeof fetch);
  const requests = () =>
    fetchImpl.mock.calls.map((call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)));
  return { store, requests };
}

describe("createLoadStore", () => {
  it("asks only for new history and appends it", async () => {
    const { store, requests } = storeWith(answer("local", [point(1), point(2)]), answer("local", [point(3)]));
    await store.poll();
    await store.poll();
    expect(requests()).toEqual([
      { machineId: null, since: 0, processes: false },
      { machineId: "local", since: NOW + 2, processes: false },
    ]);
    expect(store.getSnapshot().history.map((entry) => entry.t)).toEqual([NOW + 1, NOW + 2, NOW + 3]);
  });

  it("starts over on another machine and forgets a removed one", async () => {
    const { store, requests } = storeWith(answer("local", [point(5)]), answer("local", [point(6)]));
    store.selectMachine("gone");
    await store.poll();
    expect(store.getSnapshot().selectedMachineId).toBeNull();
    await store.poll();
    expect(requests().map((request) => [request.machineId, request.since])).toEqual([
      ["gone", 0],
      ["local", NOW + 5],
    ]);
  });

  it("keeps the last reading when a poll fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: answer("local", [point(1)]) })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { message: "boom" } }), { status: 500 }));
    const store = createLoadStore(fetchImpl as unknown as typeof fetch);
    await store.poll();
    await store.poll();
    expect(store.getSnapshot().error).toBe("boom");
    expect(store.getSnapshot().result?.machineId).toBe("local");
  });
});
