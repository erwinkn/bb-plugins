import { describe, expect, it, vi } from "vitest";
import type { Machine, Sample } from "./contract.js";
import { createLoadService, HISTORY_MS } from "./load-service.js";

const SETTINGS = { refreshMs: 3000, warningPercent: 80, criticalPercent: 95 };

function sample(takenAt: number, processes = false): Sample {
  return {
    takenAt,
    platform: "linux",
    hostname: "box",
    uptimeSeconds: 10,
    cpu: { count: 2, percent: 25, cores: [20, 30] },
    memory: { totalBytes: 100, availableBytes: 40, swapTotalBytes: 0, swapUsedBytes: 0 },
    load: [1, 1, 1],
    disks: [],
    io: { diskReadBps: 1, diskWriteBps: 2, netReceiveBps: 3, netSendBps: 4 },
    processes: processes ? { byCpu: [], byMemory: [] } : null,
  };
}

const MACHINES: Machine[] = [
  { id: "remote", name: "Remote", connected: true, primary: false },
  { id: "local", name: "Local", connected: true, primary: true },
  { id: "laptop", name: "Laptop", connected: false, primary: false },
];

function setup() {
  let now = 1_000_000;
  const sampleMachine = vi.fn(async (_machineId: string, processes: boolean) => sample(now, processes));
  const service = createLoadService({
    listMachines: async () => MACHINES,
    sampleMachine,
    settings: () => SETTINGS,
    now: () => now,
  });
  return { service, sampleMachine, advance: (ms: number) => (now += ms) };
}

describe("createLoadService", () => {
  it("defaults to the BB server's machine and shares fresh samples", async () => {
    const { service, sampleMachine, advance } = setup();
    const first = await service.load({ machineId: null, since: 0, processes: false });
    expect(first.machineId).toBe("local");
    expect(first.history).toHaveLength(1);
    expect(first.history[0]?.memory).toBe(60);
    advance(1000);
    await service.load({ machineId: "local", since: 0, processes: false });
    expect(sampleMachine).toHaveBeenCalledTimes(1);
    advance(2000);
    await service.load({ machineId: "local", since: 0, processes: false });
    expect(sampleMachine).toHaveBeenCalledTimes(2);
  });

  it("samples again when a panel needs process lists", async () => {
    const { service, sampleMachine } = setup();
    await service.load({ machineId: "local", since: 0, processes: false });
    const detailed = await service.load({ machineId: "local", since: 0, processes: true });
    expect(sampleMachine).toHaveBeenLastCalledWith("local", true);
    expect(detailed.sample?.processes).not.toBeNull();
  });

  it("coalesces concurrent requests into one host call", async () => {
    const { service, sampleMachine } = setup();
    await Promise.all([
      service.load({ machineId: "remote", since: 0, processes: false }),
      service.load({ machineId: "remote", since: 0, processes: false }),
    ]);
    expect(sampleMachine).toHaveBeenCalledTimes(1);
  });

  it("returns only history newer than since, and forgets points past 30 minutes", async () => {
    const { service, advance } = setup();
    const first = await service.load({ machineId: "local", since: 0, processes: false });
    const firstAt = first.sample!.takenAt;
    advance(5000);
    const second = await service.load({ machineId: "local", since: firstAt, processes: false });
    expect(second.history.map((point) => point.t)).toEqual([firstAt + 5000]);
    advance(HISTORY_MS + 1);
    const later = await service.load({ machineId: "local", since: 0, processes: false });
    expect(later.history.map((point) => point.t)).toEqual([firstAt + 5001 + HISTORY_MS]);
  });

  it("does not call offline machines and keeps the last error", async () => {
    const { service, sampleMachine, advance } = setup();
    const offline = await service.load({ machineId: "laptop", since: 0, processes: false });
    expect(sampleMachine).not.toHaveBeenCalled();
    expect(offline.error).toBe("Laptop is offline.");

    await service.load({ machineId: "remote", since: 0, processes: false });
    sampleMachine.mockRejectedValueOnce(new Error("worker timed out"));
    advance(5000);
    const failed = await service.load({ machineId: "remote", since: 0, processes: false });
    expect(failed.error).toBe("Could not read Remote: worker timed out");
    expect(failed.sample).not.toBeNull();
  });

  it("shares one process upgrade among detail requests queued behind a plain read", async () => {
    let now = 1_000_000;
    let active = 0;
    let peak = 0;
    let releasePlain: () => void = () => {};
    const sampleMachine = vi.fn(async (_machineId: string, processes: boolean) => {
      active += 1;
      peak = Math.max(peak, active);
      if (!processes) await new Promise<void>((resolve) => (releasePlain = resolve));
      else await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return sample(now, processes);
    });
    const service = createLoadService({
      listMachines: async () => MACHINES,
      sampleMachine,
      settings: () => SETTINGS,
      now: () => now,
    });
    const plain = service.load({ machineId: "local", since: 0, processes: false });
    await vi.waitFor(() => expect(sampleMachine).toHaveBeenCalledTimes(1));
    const detailed = Array.from({ length: 5 }, () =>
      service.load({ machineId: "local", since: 0, processes: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    releasePlain();
    const results = await Promise.all([plain, ...detailed]);
    expect(sampleMachine).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
    expect(results.slice(1).every((result) => result.sample?.processes !== null)).toBe(true);
  });

  it.each([60_000, -60_000])("keeps freshness and history on the server clock when the host is %i ms off", async (skew) => {
    let now = 1_000_000;
    const sampleMachine = vi.fn(async () => sample(now + skew));
    const service = createLoadService({
      listMachines: async () => MACHINES,
      sampleMachine,
      settings: () => SETTINGS,
      now: () => now,
    });
    const first = await service.load({ machineId: "local", since: 0, processes: false });
    expect(first.sample?.takenAt).toBe(now);
    // A second window at the same moment shares the reading.
    await service.load({ machineId: "local", since: 0, processes: false });
    expect(sampleMachine).toHaveBeenCalledTimes(1);
    // Every later interval reads again.
    for (let step = 1; step <= 10; step += 1) {
      now += 3000;
      await service.load({ machineId: "local", since: 0, processes: false });
    }
    expect(sampleMachine).toHaveBeenCalledTimes(11);
    const cursor = first.history.at(-1)!.t;
    const next = await service.load({ machineId: "local", since: cursor, processes: false });
    expect(next.history.map((point) => point.t - cursor)).toEqual(Array.from({ length: 10 }, (_, index) => (index + 1) * 3000));
  });
});
