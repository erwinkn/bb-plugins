// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LoadResult } from "../lib/contract.js";
import { createLoadStore } from "../lib/load-store.js";
import { createGaugeIcon } from "./gauge-icon.js";

function result(cpu: number, availableBytes: number, connected = true): LoadResult {
  return {
    machines: [{ id: "local", name: "Local", connected, primary: true }],
    machineId: "local",
    sample: {
      takenAt: 1,
      platform: "linux",
      hostname: "box",
      uptimeSeconds: 1,
      cpu: { count: 1, percent: cpu, cores: null },
      memory: { totalBytes: 100, availableBytes, swapTotalBytes: 0, swapUsedBytes: 0 },
      load: null,
      disks: [
        { mountPoint: "/", device: "/dev/md2", fsType: "ext4", totalBytes: 100, usedBytes: 50, availableBytes: 50 },
        { mountPoint: "/boot", device: "/dev/md1", fsType: "ext3", totalBytes: 100, usedBytes: 97, availableBytes: 3 },
      ],
      io: { diskReadBps: null, diskWriteBps: null, netReceiveBps: null, netSendBps: null },
      processes: null,
    },
    history: [],
    error: null,
    settings: { refreshMs: 3000, warningPercent: 80, criticalPercent: 95 },
  };
}

function storeAnswering(body: LoadResult) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: body })));
  return createLoadStore(fetchImpl as unknown as typeof fetch);
}

describe("MachineLoadGauge", () => {
  it("draws empty tracks before the first reading", () => {
    const Gauge = createGaugeIcon(storeAnswering(result(0, 0)));
    const { container } = render(<Gauge className="size-4" />);
    expect(container.querySelectorAll("[data-gauge-tone]")).toHaveLength(0);
  });

  it("tones CPU, memory, and the fullest disk", async () => {
    const store = storeAnswering(result(50, 15));
    const Gauge = createGaugeIcon(store);
    const { container } = render(<Gauge className="size-4" />);
    await act(() => store.poll());
    const tones = [...container.querySelectorAll("[data-gauge-tone]")].map((bar) => bar.getAttribute("data-gauge-tone"));
    expect(tones).toEqual(["normal", "warning", "critical"]);
  });

  it("goes blank for an offline machine", async () => {
    const store = storeAnswering(result(50, 15, false));
    const Gauge = createGaugeIcon(store);
    const { container } = render(<Gauge className="size-4" />);
    await act(() => store.poll());
    expect(container.querySelectorAll("[data-gauge-tone]")).toHaveLength(0);
  });

  it("goes blank when a poll fails or the host read fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: result(50, 15) })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: { message: "worker timed out" } }), { status: 500 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { ...result(50, 15), error: "Could not read Local: timeout" } })));
    const store = createLoadStore(fetchImpl as unknown as typeof fetch);
    const Gauge = createGaugeIcon(store);
    const { container } = render(<Gauge className="size-4" />);
    const filled = () => container.querySelectorAll("[data-gauge-tone]").length;
    await act(() => store.poll());
    expect(filled()).toBe(3);
    await act(() => store.poll());
    expect(filled()).toBe(0);
    expect(container.querySelector("svg")?.getAttribute("data-machine-load-gauge")).toBe("stale");
    await act(() => store.poll());
    expect(filled()).toBe(0);
  });

  it("goes blank when a poll hangs", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: result(50, 15) })))
        .mockImplementationOnce(
          (_url: string, init: RequestInit) =>
            new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
        );
      const store = createLoadStore(fetchImpl as unknown as typeof fetch);
      const Gauge = createGaugeIcon(store);
      const { container } = render(<Gauge className="size-4" />);
      await act(() => store.poll());
      const hung = store.poll();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
        await hung;
      });
      expect(store.getSnapshot().error).toBe("Machine load did not answer in time.");
      expect(container.querySelectorAll("[data-gauge-tone]")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
