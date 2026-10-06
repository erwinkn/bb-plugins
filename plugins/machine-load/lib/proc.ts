/**
 * Pure parsers for the Linux files the sampler reads, plus the delta math that
 * turns two cumulative readings into rates. Nothing here touches the
 * filesystem, so every rule is testable against fixture text.
 */

/** Cumulative jiffies for one `cpu` line of /proc/stat. */
export interface CpuTimes {
  busy: number;
  total: number;
}

export interface ProcStat {
  /** The aggregate `cpu` line. */
  total: CpuTimes;
  /** One entry per `cpuN` line, in kernel order. */
  cores: CpuTimes[];
}

function cpuTimes(fields: number[]): CpuTimes {
  // user nice system idle iowait irq softirq steal guest guest_nice.
  // guest and guest_nice are already counted inside user and nice.
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields;
  const busy = user + nice + system + irq + softirq + steal;
  return { busy, total: busy + idle + iowait };
}

export function parseProcStat(text: string): ProcStat | null {
  let total: CpuTimes | null = null;
  const cores: CpuTimes[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("cpu")) continue;
    const [label, ...rest] = line.trim().split(/\s+/u);
    const times = cpuTimes(rest.map(Number));
    if (label === "cpu") total = times;
    else if (/^cpu\d+$/u.test(label ?? "")) cores.push(times);
  }
  return total === null ? null : { total, cores };
}

/** Busy share of the elapsed jiffies, 0–100, or null without progress. */
export function cpuPercent(previous: CpuTimes, next: CpuTimes): number | null {
  const elapsed = next.total - previous.total;
  if (elapsed <= 0) return null;
  return clampPercent(((next.busy - previous.busy) / elapsed) * 100);
}

export interface Memory {
  totalBytes: number;
  /** MemAvailable: free memory plus reclaimable page cache, as `free` reports it. */
  availableBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

export function parseMeminfo(text: string): Memory | null {
  const kib = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(\w+(?:\(\w+\))?):\s+(\d+)/u.exec(line);
    if (match !== null) kib.set(match[1]!, Number(match[2]));
  }
  const total = kib.get("MemTotal");
  if (total === undefined) return null;
  // Kernels before 3.14 lack MemAvailable; approximate it the old way.
  const available =
    kib.get("MemAvailable") ??
    (kib.get("MemFree") ?? 0) + (kib.get("Buffers") ?? 0) + (kib.get("Cached") ?? 0);
  const swapTotal = kib.get("SwapTotal") ?? 0;
  const swapFree = kib.get("SwapFree") ?? 0;
  return {
    totalBytes: total * 1024,
    availableBytes: Math.min(available, total) * 1024,
    swapTotalBytes: swapTotal * 1024,
    swapUsedBytes: Math.max(0, swapTotal - swapFree) * 1024,
  };
}

export function parseLoadavg(text: string): [number, number, number] | null {
  const [one, five, fifteen] = text.trim().split(/\s+/u).map(Number);
  if (![one, five, fifteen].every((value) => Number.isFinite(value))) return null;
  return [one!, five!, fifteen!];
}

export function parseUptime(text: string): number | null {
  const seconds = Number(text.trim().split(/\s+/u)[0]);
  return Number.isFinite(seconds) ? seconds : null;
}

export interface Mount {
  mountPoint: string;
  device: string;
  fsType: string;
  /** `major:minor`, the key /proc/diskstats rows share. */
  deviceNumber: string;
}

/** Filesystems that never hold user data, whatever device they claim. */
const PSEUDO_FS_TYPES = new Set([
  "autofs", "binfmt_misc", "bpf", "cgroup", "cgroup2", "configfs", "debugfs",
  "devpts", "devtmpfs", "efivarfs", "fuse.lxcfs", "fusectl", "hugetlbfs",
  "mqueue", "nsfs", "overlay", "proc", "pstore", "ramfs", "rpc_pipefs",
  "securityfs", "squashfs", "sysfs", "tmpfs", "tracefs",
]);

/** Mount trees owned by snaps and container runtimes. */
const NOISY_MOUNT_PREFIXES = ["/snap/", "/var/snap/", "/var/lib/docker/", "/var/lib/containers/", "/run/", "/proc/", "/sys/", "/dev/"];

/** Undo the octal escapes the kernel uses for spaces and tabs in paths. */
function unescapeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/**
 * Real block-device filesystems from /proc/self/mountinfo: one entry per
 * device, at its shortest whole-filesystem mount point, so bind mounts,
 * btrfs subvolumes, and container views of the same disk do not repeat it.
 */
export function parseMountinfo(text: string): Mount[] {
  const byDevice = new Map<string, Mount & { wholeFilesystem: boolean }>();
  for (const line of text.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const [, , deviceNumber, root, rawMountPoint] = line.slice(0, separator).split(" ");
    const [fsType, rawDevice] = line.slice(separator + 3).split(" ");
    if (deviceNumber === undefined || root === undefined || rawMountPoint === undefined) continue;
    if (fsType === undefined || rawDevice === undefined) continue;
    const mountPoint = unescapeMountPath(rawMountPoint);
    const device = unescapeMountPath(rawDevice);
    if (PSEUDO_FS_TYPES.has(fsType)) continue;
    if (!device.startsWith("/dev/") || device.startsWith("/dev/loop")) continue;
    if (NOISY_MOUNT_PREFIXES.some((prefix) => mountPoint.startsWith(prefix))) continue;
    const candidate = { mountPoint, device, fsType, deviceNumber, wholeFilesystem: root === "/" };
    const existing = byDevice.get(device);
    if (existing !== undefined && preferredMount(existing, candidate) === existing) continue;
    byDevice.set(device, candidate);
  }
  return [...byDevice.values()]
    .map(({ wholeFilesystem: _, ...mount }) => mount)
    .sort((left, right) => left.mountPoint.localeCompare(right.mountPoint));
}

function preferredMount<T extends { mountPoint: string; wholeFilesystem: boolean }>(left: T, right: T): T {
  if (left.wholeFilesystem !== right.wholeFilesystem) return left.wholeFilesystem ? left : right;
  return right.mountPoint.length < left.mountPoint.length ? right : left;
}

export interface Counters {
  readBytes: number;
  writeBytes: number;
}

/**
 * Counters keyed by the device or interface they belong to. Rates compare
 * like with like, so a disk mounted or an interface added between two
 * readings never shows up as its whole lifetime of traffic.
 */
export type CounterSet = Map<string, Counters>;

/**
 * Bytes read and written by the given devices, matched by `major:minor` or by
 * kernel name (`md2`, `nvme0n1p1`). Names cover btrfs, whose mountinfo
 * numbers are anonymous.
 */
export function parseDiskstats(text: string, devices: ReadonlySet<string>): CounterSet {
  const counters: CounterSet = new Map();
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 10) continue;
    if (!devices.has(`${fields[0]}:${fields[1]}`) && !devices.has(fields[2]!)) continue;
    // Sectors in diskstats are always 512 bytes, whatever the device uses.
    counters.set(fields[2]!, { readBytes: Number(fields[5]) * 512, writeBytes: Number(fields[9]) * 512 });
  }
  return counters;
}

/** Received and sent bytes per interface, for the given ones; all but `lo` when null. */
export function parseNetDev(text: string, interfaces: ReadonlySet<string> | null): CounterSet {
  const counters: CounterSet = new Map();
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (interfaces === null ? name === "lo" : !interfaces.has(name)) continue;
    const fields = line.slice(colon + 1).trim().split(/\s+/u);
    if (fields.length < 9) continue;
    counters.set(name, { readBytes: Number(fields[0]), writeBytes: Number(fields[8]) });
  }
  return counters;
}

/**
 * Per-second rates between two readings, summed over the identities present
 * in both. One that reset (counter went down) is left out; null when no
 * identity carries over or no time passed.
 */
export function counterRates(
  previous: CounterSet,
  next: CounterSet,
  elapsedMs: number,
): Counters | null {
  if (elapsedMs <= 0) return null;
  let read = 0;
  let write = 0;
  let compared = 0;
  for (const [key, after] of next) {
    const before = previous.get(key);
    if (before === undefined) continue;
    const readDelta = after.readBytes - before.readBytes;
    const writeDelta = after.writeBytes - before.writeBytes;
    if (readDelta < 0 || writeDelta < 0) continue;
    read += readDelta;
    write += writeDelta;
    compared += 1;
  }
  if (compared === 0) return null;
  return { readBytes: (read * 1000) / elapsedMs, writeBytes: (write * 1000) / elapsedMs };
}

export interface ProcessStat {
  pid: number;
  name: string;
  /** utime + stime, in jiffies. */
  cpuTicks: number;
  /** Jiffies after boot when the process started; tells reused pids apart. */
  startTicks: number;
  rssPages: number;
}

/** One /proc/<pid>/stat line. The name sits in parentheses and may contain them. */
export function parsePidStat(text: string): ProcessStat | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const fields = text.slice(close + 2).trim().split(/\s+/u);
  // fields[0] is field 3 (state); utime is field 14, stime 15, starttime 22, rss 24.
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const startTicks = Number(fields[19]);
  const rssPages = Number(fields[21]);
  if (![pid, utime, stime, startTicks, rssPages].every((value) => Number.isFinite(value))) return null;
  return { pid, name: text.slice(open + 1, close), cpuTicks: utime + stime, startTicks, rssPages };
}

/** /proc/<pid>/cmdline joins arguments with NUL bytes. */
export function parseCmdline(text: string): string {
  return text.replace(/\0+$/u, "").replace(/\0/gu, " ").trim();
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
