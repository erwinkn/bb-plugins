import { describe, expect, it } from "vitest";
import { createSampler, cpuTimesFromOs, type StatFs, type SystemReader } from "./sampler.js";

interface FakeMachine {
  files: Map<string, string>;
  dirs: Map<string, string[]>;
  existing: Set<string>;
  statfs: Map<string, StatFs>;
  now: number;
}

function stat(user: number, idle: number): string {
  return `cpu  ${user * 2} 0 0 ${idle * 2} 0 0 0 0 0 0\ncpu0 ${user} 0 0 ${idle} 0 0 0 0 0 0\ncpu1 ${user} 0 0 ${idle} 0 0 0 0 0 0\n`;
}

function pidStat(pid: number, name: string, ticks: number, rssPages: number, start = 100): string {
  return `${pid} (${name}) S 1 1 1 0 -1 0 0 0 0 0 ${ticks} 0 0 0 20 0 1 0 ${start} 0 ${rssPages} 0`;
}

function linuxMachine(): FakeMachine {
  return {
    files: new Map([
      ["/proc/stat", stat(100, 900)],
      ["/proc/meminfo", "MemTotal: 1000 kB\nMemAvailable: 600 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n"],
      ["/proc/self/mountinfo", "48 1 9:2 / / rw - ext4 /dev/md2 rw\n34 48 0:29 / /run rw - tmpfs tmpfs rw\n"],
      ["/proc/loadavg", "1.50 1.00 0.50 1/100 42\n"],
      ["/proc/uptime", "3600.00 100.00\n"],
      ["/proc/diskstats", "   9       2 md2 0 0 1000 0 0 0 2000 0 0 0 0\n"],
      ["/proc/net/dev", "eth0: 10000 0 0 0 0 0 0 0 5000 0 0 0 0 0 0 0\nveth1: 99999 0 0 0 0 0 0 0 99999 0 0 0 0 0 0 0\n"],
      ["/proc/10/stat", pidStat(10, "node", 0, 1000)],
      ["/proc/10/cmdline", "node\0server.js\0"],
      ["/proc/11/stat", pidStat(11, "postgres", 0, 3000)],
      ["/proc/11/cmdline", ""],
    ]),
    dirs: new Map([
      ["/sys/class/net", ["lo", "eth0", "veth1"]],
      ["/proc", ["10", "11", "self", "stat"]],
    ]),
    existing: new Set(["/sys/class/net/eth0/device"]),
    statfs: new Map([["/", { bsize: 4096, blocks: 1000, bfree: 400, bavail: 300 }]]),
    now: 1_000_000,
  };
}

function readerFor(machine: FakeMachine, platform = "linux"): SystemReader {
  return {
    readText: async (path) => machine.files.get(path) ?? null,
    listDir: async (path) => machine.dirs.get(path) ?? null,
    exists: async (path) => machine.existing.has(path),
    statfs: async (path) => machine.statfs.get(path) ?? null,
    now: () => machine.now,
    sleep: async (ms) => {
      machine.now += ms;
    },
    os: {
      platform,
      hostname: () => "box",
      cpuTimes: () => cpuTimesFromOs([{ times: { user: 10, nice: 0, sys: 0, idle: 90, irq: 0 } }]),
      totalmem: () => 2048,
      freemem: () => 1024,
      loadavg: () => [0.5, 0.25, 0.1],
      uptime: () => 60,
      pageSize: async () => 4096,
    },
  };
}

describe("createSampler on Linux", () => {
  it("reports levels at once and rates from the second reading", async () => {
    const machine = linuxMachine();
    const sampler = createSampler(readerFor(machine));
    const first = await sampler.sample({ processes: false });
    expect(first.cpu).toEqual({ count: 2, percent: null, cores: null });
    expect(first.memory.availableBytes).toBe(600 * 1024);
    expect(first.load).toEqual([1.5, 1, 0.5]);
    expect(first.uptimeSeconds).toBe(3600);
    expect(first.disks).toEqual([
      {
        mountPoint: "/",
        device: "/dev/md2",
        fsType: "ext4",
        totalBytes: 4096 * 1000,
        usedBytes: 4096 * 600,
        availableBytes: 4096 * 300,
      },
    ]);
    expect(first.io.diskReadBps).toBeNull();
    expect(first.processes).toBeNull();

    machine.now += 2000;
    machine.files.set("/proc/stat", stat(150, 950));
    machine.files.set("/proc/diskstats", "   9       2 md2 0 0 3000 0 0 0 6000 0 0 0 0\n");
    machine.files.set("/proc/net/dev", "eth0: 30000 0 0 0 0 0 0 0 9000 0 0 0 0 0 0 0\nveth1: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n");
    const second = await sampler.sample({ processes: false });
    expect(second.cpu).toEqual({ count: 2, percent: 50, cores: [50, 50] });
    expect(second.io).toEqual({
      diskReadBps: 512_000,
      diskWriteBps: 1_024_000,
      // Only eth0 has a backing device; veth1 would double count.
      netReceiveBps: 10_000,
      netSendBps: 2_000,
    });
  });

  it("measures processes against a fresh baseline", async () => {
    const machine = linuxMachine();
    const reader = readerFor(machine);
    const sleep = reader.sleep;
    reader.sleep = async (ms) => {
      // Between the two scans: node burns one core, postgres restarts under the same pid.
      machine.files.set("/proc/stat", stat(150, 950));
      machine.files.set("/proc/10/stat", pidStat(10, "node", 100, 1000));
      machine.files.set("/proc/11/stat", pidStat(11, "postgres", 50, 3000, 999));
      await sleep(ms);
    };
    const sample = await createSampler(reader).sample({ processes: true });
    expect(sample.processes?.byCpu).toEqual([
      { pid: 10, name: "node", command: "node server.js", cpuPercent: 100, memoryBytes: 4096 * 1000 },
    ]);
    expect(sample.processes?.byMemory.map((row) => [row.name, row.command, row.cpuPercent])).toEqual([
      ["postgres", "postgres", null],
      ["node", "node server.js", 100],
    ]);
  });
});

describe("createSampler throughput identities", () => {
  it("does not count a disk mounted between readings as recent I/O", async () => {
    const machine = linuxMachine();
    const diskstats = [
      "   9       2 md2 0 0 1000 0 0 0 2000 0 0 0 0",
      "   8      16 sdb 0 0 1000000 0 0 0 1000000 0 0 0 0",
    ].join("\n");
    machine.files.set("/proc/diskstats", diskstats);
    const sampler = createSampler(readerFor(machine));
    await sampler.sample({ processes: false });
    machine.now += 3000;
    machine.files.set(
      "/proc/self/mountinfo",
      "48 1 9:2 / / rw - ext4 /dev/md2 rw\n70 48 8:16 / /mnt/data rw - ext4 /dev/sdb rw\n",
    );
    machine.statfs.set("/mnt/data", { bsize: 4096, blocks: 10, bfree: 10, bavail: 10 });
    const after = await sampler.sample({ processes: false });
    expect(after.disks.map((disk) => disk.mountPoint)).toEqual(["/", "/mnt/data"]);
    expect(after.io.diskReadBps).toBe(0);
    expect(after.io.diskWriteBps).toBe(0);
  });

  it("does not count a newly physical interface as recent traffic", async () => {
    const machine = linuxMachine();
    machine.files.set(
      "/proc/net/dev",
      "eth0: 10000 0 0 0 0 0 0 0 5000 0 0 0 0 0 0 0\neth1: 9000000 0 0 0 0 0 0 0 9000000 0 0 0 0 0 0 0\n",
    );
    const sampler = createSampler(readerFor(machine));
    await sampler.sample({ processes: false });
    // The interface cache expires and eth1 now has a backing device.
    machine.now += 61_000;
    machine.dirs.set("/sys/class/net", ["lo", "eth0", "eth1"]);
    machine.existing.add("/sys/class/net/eth1/device");
    const after = await sampler.sample({ processes: false });
    expect(after.io.netReceiveBps).toBe(0);
    expect(after.io.netSendBps).toBe(0);
  });
});

describe("createSampler elsewhere", () => {
  it("falls back to node:os and the root filesystem", async () => {
    const machine = linuxMachine();
    machine.files.clear();
    const sample = await createSampler(readerFor(machine, "darwin")).sample({ processes: true });
    expect(sample.cpu.count).toBe(1);
    expect(sample.memory).toEqual({ totalBytes: 2048, availableBytes: 1024, swapTotalBytes: 0, swapUsedBytes: 0 });
    expect(sample.load).toEqual([0.5, 0.25, 0.1]);
    expect(sample.disks.map((disk) => disk.mountPoint)).toEqual(["/"]);
    expect(sample.io.netReceiveBps).toBeNull();
    expect(sample.processes).toBeNull();
  });
});
