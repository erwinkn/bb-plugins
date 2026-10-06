/**
 * Reads one machine's load. Cumulative counters (CPU jiffies, disk sectors,
 * network bytes, per-process ticks) become rates against the previous call,
 * so the sampler keeps those readings between calls. On Linux everything
 * comes from /proc, /sys, and statfs; elsewhere it falls back to `node:os`
 * and the root filesystem.
 */
import type { Disk, ProcessSummary, Sample } from "./contract.js";
import {
  counterRates,
  cpuPercent,
  parseCmdline,
  parseDiskstats,
  parseLoadavg,
  parseMeminfo,
  parseMountinfo,
  parseNetDev,
  parsePidStat,
  parseProcStat,
  parseUptime,
  type CounterSet,
  type Counters,
  type CpuTimes,
  type Memory,
  type Mount,
  type ProcStat,
  type ProcessStat,
} from "./proc.js";

export interface StatFs {
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
}

/** Everything the sampler reads, so tests can feed it fixtures. */
export interface SystemReader {
  /** File contents, or null when the file is missing or unreadable. */
  readText(path: string): Promise<string | null>;
  listDir(path: string): Promise<string[] | null>;
  exists(path: string): Promise<boolean>;
  statfs(path: string): Promise<StatFs | null>;
  now(): number;
  sleep(ms: number): Promise<void>;
  os: {
    platform: string;
    hostname(): string;
    /** Summed per-core times from os.cpus(); the non-Linux CPU source. */
    cpuTimes(): ProcStat;
    totalmem(): number;
    freemem(): number;
    loadavg(): [number, number, number];
    uptime(): number;
    /** Bytes per page for /proc/<pid>/stat RSS. */
    pageSize(): Promise<number>;
  };
}

const TOP_PROCESSES = 5;
/** A process baseline older than this is too coarse to report as current CPU. */
const PROCESS_BASELINE_MAX_AGE_MS = 15_000;
/** The gap between two process scans when no recent baseline exists. */
const PROCESS_BASELINE_GAP_MS = 500;
const INTERFACE_CACHE_MS = 60_000;
const PROCESS_READ_CONCURRENCY = 64;
/** Enough of a command line to tell processes apart in a tooltip. */
const COMMAND_MAX_LENGTH = 400;

interface CounterReading {
  at: number;
  counters: CounterSet;
}

interface ProcessReading {
  at: number;
  /** Aggregate jiffies across all cores at scan time. */
  totalTicks: number;
  byPid: Map<number, ProcessStat>;
}

export function createSampler(reader: SystemReader) {
  const linux = reader.os.platform === "linux";
  let previousCpu: ProcStat | null = null;
  let previousDisk: CounterReading | null = null;
  let previousNet: CounterReading | null = null;
  let previousProcesses: ProcessReading | null = null;
  let interfaces: { at: number; names: ReadonlySet<string> | null } | null = null;
  let pageSize: number | null = null;

  async function readCpu(): Promise<ProcStat | null> {
    if (!linux) return reader.os.cpuTimes();
    const text = await reader.readText("/proc/stat");
    return text === null ? reader.os.cpuTimes() : parseProcStat(text);
  }

  async function readMemory(): Promise<Memory> {
    const text = linux ? await reader.readText("/proc/meminfo") : null;
    const parsed = text === null ? null : parseMeminfo(text);
    if (parsed !== null) return parsed;
    return {
      totalBytes: reader.os.totalmem(),
      availableBytes: reader.os.freemem(),
      swapTotalBytes: 0,
      swapUsedBytes: 0,
    };
  }

  async function readMounts(): Promise<Mount[]> {
    const text = linux ? await reader.readText("/proc/self/mountinfo") : null;
    const mounts = text === null ? [] : parseMountinfo(text);
    return mounts.length > 0
      ? mounts
      : [{ mountPoint: "/", device: "/", fsType: "", deviceNumber: "" }];
  }

  async function readDisks(mounts: Mount[]): Promise<Disk[]> {
    const disks = await Promise.all(
      mounts.map(async (mount): Promise<Disk | null> => {
        const stats = await reader.statfs(mount.mountPoint);
        if (stats === null || stats.blocks === 0) return null;
        return {
          mountPoint: mount.mountPoint,
          device: mount.device,
          fsType: mount.fsType,
          totalBytes: stats.blocks * stats.bsize,
          usedBytes: (stats.blocks - stats.bfree) * stats.bsize,
          availableBytes: stats.bavail * stats.bsize,
        };
      }),
    );
    return disks.filter((disk) => disk !== null);
  }

  /** Physical interfaces, the ones with a backing device; bridges and veths would double count. */
  async function physicalInterfaces(now: number): Promise<ReadonlySet<string> | null> {
    if (interfaces !== null && now - interfaces.at < INTERFACE_CACHE_MS) return interfaces.names;
    const names = (await reader.listDir("/sys/class/net")) ?? [];
    const physical = new Set<string>();
    await Promise.all(
      names.map(async (name) => {
        if (await reader.exists(`/sys/class/net/${name}/device`)) physical.add(name);
      }),
    );
    interfaces = { at: now, names: physical.size === 0 ? null : physical };
    return interfaces.names;
  }

  async function readRates(
    mounts: Mount[],
    now: number,
  ): Promise<Sample["io"]> {
    if (!linux) return { diskReadBps: null, diskWriteBps: null, netReceiveBps: null, netSendBps: null };
    const [diskstats, netdev, names] = await Promise.all([
      reader.readText("/proc/diskstats"),
      reader.readText("/proc/net/dev"),
      physicalInterfaces(now),
    ]);
    const devices = new Set<string>();
    for (const mount of mounts) {
      if (mount.deviceNumber !== "") devices.add(mount.deviceNumber);
      devices.add(mount.device.slice(mount.device.lastIndexOf("/") + 1));
    }
    const disk = diskstats === null ? null : { at: now, counters: parseDiskstats(diskstats, devices) };
    const net = netdev === null ? null : { at: now, counters: parseNetDev(netdev, names) };
    const diskRates = rates(previousDisk, disk);
    const netRates = rates(previousNet, net);
    previousDisk = disk;
    previousNet = net;
    return {
      diskReadBps: diskRates?.readBytes ?? null,
      diskWriteBps: diskRates?.writeBytes ?? null,
      netReceiveBps: netRates?.readBytes ?? null,
      netSendBps: netRates?.writeBytes ?? null,
    };
  }

  async function scanProcesses(totalTicks: number): Promise<ProcessReading> {
    const at = reader.now();
    const pids = ((await reader.listDir("/proc")) ?? []).filter((name) => /^\d+$/u.test(name));
    const byPid = new Map<number, ProcessStat>();
    for (let index = 0; index < pids.length; index += PROCESS_READ_CONCURRENCY) {
      const batch = pids.slice(index, index + PROCESS_READ_CONCURRENCY);
      const stats = await Promise.all(
        batch.map(async (pid) => {
          const text = await reader.readText(`/proc/${pid}/stat`);
          return text === null ? null : parsePidStat(text);
        }),
      );
      for (const stat of stats) if (stat !== null) byPid.set(stat.pid, stat);
    }
    return { at, totalTicks, byPid };
  }

  async function readProcesses(cpuCount: number): Promise<Sample["processes"]> {
    if (!linux) return null;
    pageSize ??= await reader.os.pageSize();
    const ticks = async () => (await readCpu())?.total.total ?? 0;
    let baseline = previousProcesses;
    if (baseline === null || reader.now() - baseline.at > PROCESS_BASELINE_MAX_AGE_MS) {
      baseline = await scanProcesses(await ticks());
      await reader.sleep(PROCESS_BASELINE_GAP_MS);
    }
    const current = await scanProcesses(await ticks());
    previousProcesses = current;
    // Jiffies one core advanced over the interval; a process at 100% used them all.
    const coreTicks = (current.totalTicks - baseline.totalTicks) / cpuCount;
    const rows = [...current.byPid.values()].map((stat) => {
      const before = baseline.byPid.get(stat.pid);
      const sameProcess = before !== undefined && before.startTicks === stat.startTicks;
      const cpu =
        sameProcess && coreTicks > 0
          ? Math.max(0, ((stat.cpuTicks - before.cpuTicks) / coreTicks) * 100)
          : null;
      return { stat, cpu, memory: stat.rssPages * pageSize! };
    });
    const byCpu = rows
      .filter((row) => row.cpu !== null && row.cpu > 0)
      .sort((left, right) => right.cpu! - left.cpu!)
      .slice(0, TOP_PROCESSES);
    const byMemory = [...rows].sort((left, right) => right.memory - left.memory).slice(0, TOP_PROCESSES);
    const summarize = async (row: (typeof rows)[number]): Promise<ProcessSummary> => {
      const cmdline = await reader.readText(`/proc/${row.stat.pid}/cmdline`);
      const command = cmdline === null ? "" : parseCmdline(cmdline).slice(0, COMMAND_MAX_LENGTH);
      return {
        pid: row.stat.pid,
        name: row.stat.name,
        command: command === "" ? row.stat.name : command,
        cpuPercent: row.cpu,
        memoryBytes: row.memory,
      };
    };
    return {
      byCpu: await Promise.all(byCpu.map(summarize)),
      byMemory: await Promise.all(byMemory.map(summarize)),
    };
  }

  async function sample({ processes }: { processes: boolean }): Promise<Sample> {
    const now = reader.now();
    const [cpu, memory, mounts, loadText, uptimeText] = await Promise.all([
      readCpu(),
      readMemory(),
      readMounts(),
      linux ? reader.readText("/proc/loadavg") : Promise.resolve(null),
      linux ? reader.readText("/proc/uptime") : Promise.resolve(null),
    ]);
    const [disks, io] = await Promise.all([readDisks(mounts), readRates(mounts, now)]);
    const cpuCount = Math.max(1, cpu?.cores.length ?? 1);
    const before = previousCpu;
    previousCpu = cpu;
    const percent = before === null || cpu === null ? null : cpuPercent(before.total, cpu.total);
    const cores =
      before === null || cpu === null || before.cores.length !== cpu.cores.length
        ? null
        : cpu.cores.map((core, index) => cpuPercent(before.cores[index]!, core) ?? 0);
    const load =
      (loadText === null ? null : parseLoadavg(loadText)) ??
      (reader.os.platform === "win32" ? null : reader.os.loadavg());
    const uptime = (uptimeText === null ? null : parseUptime(uptimeText)) ?? reader.os.uptime();
    return {
      takenAt: now,
      platform: reader.os.platform,
      hostname: reader.os.hostname(),
      uptimeSeconds: uptime,
      cpu: { count: cpuCount, percent, cores },
      memory,
      load,
      disks,
      io,
      processes: processes ? await readProcesses(cpuCount) : null,
    };
  }

  return { sample };
}

function rates(previous: CounterReading | null, next: CounterReading | null): Counters | null {
  if (previous === null || next === null) return null;
  return counterRates(previous.counters, next.counters, next.at - previous.at);
}

/** Sum os.cpus() into the /proc/stat shape. */
export function cpuTimesFromOs(cpus: ReadonlyArray<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>): ProcStat {
  const cores: CpuTimes[] = cpus.map(({ times }) => {
    const busy = times.user + times.nice + times.sys + times.irq;
    return { busy, total: busy + times.idle };
  });
  const total = cores.reduce(
    (sum, core) => ({ busy: sum.busy + core.busy, total: sum.total + core.total }),
    { busy: 0, total: 0 },
  );
  return { total, cores };
}
