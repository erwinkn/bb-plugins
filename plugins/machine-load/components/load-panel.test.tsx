// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LoadResult } from "../lib/contract.js";
import { createLoadStore } from "../lib/load-store.js";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

const { createLoadPanel } = await import("./load-panel.js");

const GIB = 1024 ** 3;

function result(): LoadResult {
  return {
    machines: [
      { id: "local", name: "hetzner", connected: true, primary: true },
      { id: "mac", name: "MacBook", connected: false, primary: false },
    ],
    machineId: "local",
    sample: {
      takenAt: 120_000,
      platform: "linux",
      hostname: "box",
      uptimeSeconds: 3 * 86_400,
      cpu: { count: 4, percent: 23, cores: [10, 20, 30, 90] },
      memory: { totalBytes: 251 * GIB, availableBytes: 210 * GIB, swapTotalBytes: 4 * GIB, swapUsedBytes: 0 },
      load: [3.2, 2.1, 1.05],
      disks: [{ mountPoint: "/", device: "/dev/md2", fsType: "ext4", totalBytes: 1754 * GIB, usedBytes: 57 * GIB, availableBytes: 1608 * GIB }],
      io: { diskReadBps: 2048, diskWriteBps: 2 * 1024 ** 2, netReceiveBps: 125_000, netSendBps: null },
      processes: {
        byCpu: [{ pid: 7, name: "node", command: "node server.js", cpuPercent: 340, memoryBytes: GIB }],
        byMemory: [{ pid: 9, name: "chrome", command: "chrome --type=renderer", cpuPercent: 8, memoryBytes: 2.6 * GIB }],
      },
    },
    history: [
      { t: 0, cpu: 10, memory: 15, diskRead: 0, diskWrite: 0, netReceive: 0, netSend: 0 },
      { t: 3_000, cpu: 30, memory: 16, diskRead: 0, diskWrite: 0, netReceive: 0, netSend: 0 },
      { t: 120_000, cpu: 23, memory: 16, diskRead: 0, diskWrite: 0, netReceive: 0, netSend: 0 },
    ],
    error: null,
    settings: { refreshMs: 3000, warningPercent: 80, criticalPercent: 95 },
  };
}

describe("MachineLoadPanel", () => {
  it("shows every resource and asks for process lists while open", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: result() })));
    const store = createLoadStore(fetchImpl as unknown as typeof fetch);
    const Panel = createLoadPanel(store);
    render(<Panel dismiss={() => {}} />);
    await act(() => store.poll());

    const request = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(request).toEqual({ machineId: null, since: 0, processes: true });
    expect(screen.getByText("hetzner")).toBeTruthy();
    expect(screen.getByText("4 cores · up 3 d")).toBeTruthy();
    expect(screen.getByText("23%")).toBeTruthy();
    expect(screen.getByText("41.0 / 251 GiB")).toBeTruthy();
    expect(screen.getByText("3.20")).toBeTruthy();
    expect(screen.getByText("/ 4")).toBeTruthy();
    expect(screen.getByText("57.0 GiB / 1.71 TiB")).toBeTruthy();
    expect(screen.getByText("↓ 2.00 KiB/s")).toBeTruthy();
    expect(screen.getByText("↑ 2.00 MiB/s")).toBeTruthy();
    expect(screen.getByText("↓ 122 KiB/s")).toBeTruthy();
    expect(screen.getByText("↑ –")).toBeTruthy();
    expect(screen.getByLabelText("CPU over the last 2 min")).toBeTruthy();
    expect(document.querySelector("[data-core-grid]")?.children).toHaveLength(4);
    expect(screen.getByText("340%")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Memory" }));
    expect(screen.getByText("chrome")).toBeTruthy();
    expect(screen.getByText("2.60 GiB")).toBeTruthy();
  });

  it("stops asking for process lists once closed", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: result() })));
    const store = createLoadStore(fetchImpl as unknown as typeof fetch);
    const Panel = createLoadPanel(store);
    const { unmount } = render(<Panel dismiss={() => {}} />);
    unmount();
    await store.poll();
    const request = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(request.processes).toBe(false);
  });

  it("dismisses on a click outside", () => {
    const store = createLoadStore((async () => new Response("{}")) as unknown as typeof fetch);
    const Panel = createLoadPanel(store);
    const dismiss = vi.fn();
    render(<Panel dismiss={dismiss} />);
    fireEvent.pointerDown(document.body);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});
