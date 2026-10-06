import { describe, expect, it } from "vitest";
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
} from "./proc.js";

const STAT_BEFORE = `cpu  1000 0 500 8000 500 0 0 0 0 0
cpu0 600 0 300 3900 200 0 0 0 0 0
cpu1 400 0 200 4100 300 0 0 0 0 0
intr 123456
ctxt 98765
`;

// cpu0 is fully busy for 100 jiffies; cpu1 idles them.
const STAT_AFTER = `cpu  1080 0 520 8100 500 0 0 0 0 0
cpu0 680 0 320 3900 200 0 0 0 0 0
cpu1 400 0 200 4200 300 0 0 0 0 0
intr 123999
`;

describe("parseProcStat and cpuPercent", () => {
  it("reads the aggregate and per-core lines", () => {
    const stat = parseProcStat(STAT_BEFORE)!;
    expect(stat.cores).toHaveLength(2);
    expect(stat.total).toEqual({ busy: 1500, total: 10000 });
  });

  it("turns two readings into busy shares", () => {
    const before = parseProcStat(STAT_BEFORE)!;
    const after = parseProcStat(STAT_AFTER)!;
    expect(cpuPercent(before.total, after.total)).toBe(50);
    expect(cpuPercent(before.cores[0]!, after.cores[0]!)).toBe(100);
    expect(cpuPercent(before.cores[1]!, after.cores[1]!)).toBe(0);
  });

  it("counts iowait as idle and steal as busy, and ignores guest double counting", () => {
    const before = parseProcStat("cpu  0 0 0 0 0 0 0 0 0 0\n")!;
    // user 10 (includes guest 10), iowait 30, steal 10, idle 50.
    const after = parseProcStat("cpu  10 0 0 50 30 0 0 10 10 0\n")!;
    expect(cpuPercent(before.total, after.total)).toBe(20);
  });

  it("reports nothing when no time passed", () => {
    const stat = parseProcStat(STAT_BEFORE)!;
    expect(cpuPercent(stat.total, stat.total)).toBeNull();
  });

  it("rejects text without a cpu line", () => {
    expect(parseProcStat("intr 1\n")).toBeNull();
  });
});

describe("parseMeminfo", () => {
  const MEMINFO = `MemTotal:       263547516 kB
MemFree:        10000000 kB
MemAvailable:   200000000 kB
Buffers:         1000000 kB
Cached:         150000000 kB
SwapCached:            0 kB
Active(anon):    5000000 kB
SwapTotal:       8388604 kB
SwapFree:        8000000 kB
HugePages_Total:       0
`;

  it("counts page cache as available, like free", () => {
    const memory = parseMeminfo(MEMINFO)!;
    expect(memory.totalBytes).toBe(263547516 * 1024);
    expect(memory.availableBytes).toBe(200000000 * 1024);
    expect(memory.swapTotalBytes).toBe(8388604 * 1024);
    expect(memory.swapUsedBytes).toBe(388604 * 1024);
  });

  it("approximates MemAvailable on old kernels", () => {
    const memory = parseMeminfo("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 200 kB\n")!;
    expect(memory.availableBytes).toBe(350 * 1024);
    expect(memory.swapTotalBytes).toBe(0);
  });

  it("rejects text without MemTotal", () => {
    expect(parseMeminfo("MemFree: 1 kB\n")).toBeNull();
  });
});

describe("parseMountinfo", () => {
  // Trimmed from this box (md RAID root) plus the noise a dev machine collects.
  const MOUNTINFO = [
    "34 48 0:29 / /run rw,nosuid,nodev shared:13 - tmpfs tmpfs rw,size=52716060k",
    "48 1 9:2 / / rw,relatime shared:1 - ext4 /dev/md2 rw,stripe=32",
    "41 48 0:7 / /dev rw,nosuid shared:2 - devtmpfs devtmpfs rw",
    "42 41 0:27 / /dev/shm rw,nosuid,nodev shared:3 - tmpfs tmpfs rw,inode64",
    "60 48 0:5 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw",
    "61 48 0:6 / /sys rw,nosuid,nodev,noexec,relatime shared:7 - sysfs sysfs rw",
    "80 48 9:1 / /boot rw,relatime shared:30 - ext3 /dev/md1 rw",
    "81 80 259:1 / /boot/efi rw,relatime shared:31 - vfat /dev/nvme0n1p1 rw",
    "90 48 7:0 / /snap/core22/1380 ro,nodev,relatime shared:40 - squashfs /dev/loop0 ro",
    "91 48 0:50 / /var/lib/docker/overlay2/abc/merged rw,relatime - overlay overlay rw,lowerdir=x",
    "92 48 9:2 /home/erwin/data /srv/data rw,relatime shared:1 - ext4 /dev/md2 rw",
    "93 48 0:60 / /mnt/nas rw,relatime - nfs4 nas:/export rw",
    "94 48 0:33 /@home /home rw,relatime - btrfs /dev/sdb2 rw",
    "95 48 0:34 /@ /data\\040disk rw,relatime - btrfs /dev/sdb2 rw",
    "96 48 0:35 / /var/snap/lxd/common/ns rw - tmpfs tmpfs rw",
  ].join("\n");

  it("keeps one entry per real block device", () => {
    expect(parseMountinfo(MOUNTINFO).map((mount) => mount.mountPoint)).toEqual([
      "/",
      "/boot",
      "/boot/efi",
      "/home",
    ]);
  });

  it("keeps the device number for diskstats", () => {
    const root = parseMountinfo(MOUNTINFO).find((mount) => mount.mountPoint === "/")!;
    expect(root).toEqual({ mountPoint: "/", device: "/dev/md2", fsType: "ext4", deviceNumber: "9:2" });
  });

  it("prefers the whole-filesystem mount over a subdirectory bind", () => {
    const mounts = parseMountinfo(
      [
        "92 48 9:2 /home/erwin/data /srv/data rw - ext4 /dev/md2 rw",
        "48 1 9:2 / /var/lib/x rw - ext4 /dev/md2 rw",
      ].join("\n"),
    );
    expect(mounts.map((mount) => mount.mountPoint)).toEqual(["/var/lib/x"]);
  });

  it("unescapes spaces in mount points", () => {
    const [mount] = parseMountinfo("95 48 0:34 / /data\\040disk rw - ext4 /dev/sdc1 rw");
    expect(mount?.mountPoint).toBe("/data disk");
  });
});

describe("parseDiskstats", () => {
  const DISKSTATS = [
    "   7       0 loop0 30 0 60 0 0 0 0 0 0 0 0 0 0 0 0 0 0",
    " 259       0 nvme0n1 1000 0 5000 0 100 0 2000 0 0 0 0 0 0 0 0 0 0",
    " 259       1 nvme0n1p1 235 131 20401 15 1 0 1 0 0 15 15 0 0 0 0 0 0",
    "   9       1 md1 300 0 14986 79 3189 0 715912 21741 0 154 21820 0 0 0 0 0 0",
    "   9       2 md2 63265 0 9050986 11478 10330837 0 374816616 5875663 0 3076917 5887141 0 0 0 0 0 0",
  ].join("\n");

  it("sums 512-byte sectors of the mounted devices only", () => {
    expect(parseDiskstats(DISKSTATS, new Set(["9:2", "9:1"]))).toEqual(
      new Map([
        ["md1", { readBytes: 14986 * 512, writeBytes: 715912 * 512 }],
        ["md2", { readBytes: 9050986 * 512, writeBytes: 374816616 * 512 }],
      ]),
    );
  });

  it("matches by kernel name when the number is anonymous", () => {
    expect(parseDiskstats(DISKSTATS, new Set(["0:33", "nvme0n1p1"]))).toEqual(
      new Map([["nvme0n1p1", { readBytes: 20401 * 512, writeBytes: 512 }]]),
    );
  });
});

describe("parseNetDev and counterRates", () => {
  const NETDEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 4076662589 6292979    0    0    0     0          0         0 4076662589 6292979    0    0    0     0       0          0
enp193s0f0np0: 5000000 2384    0    0    0     0          0         0   1000000 1187    0    0    0     0       0          0
docker0:  700000    2384    0    0    0     0          0         0   300000    1187    0    0    0     0       0          0
`;

  it("sums the named interfaces", () => {
    expect(parseNetDev(NETDEV, new Set(["enp193s0f0np0"]))).toEqual(
      new Map([["enp193s0f0np0", { readBytes: 5000000, writeBytes: 1000000 }]]),
    );
  });

  it("keeps everything but loopback without a list", () => {
    expect([...parseNetDev(NETDEV, null).keys()]).toEqual(["enp193s0f0np0", "docker0"]);
  });

  it("converts counter deltas to per-second rates", () => {
    expect(
      counterRates(
        new Map([["eth0", { readBytes: 1000, writeBytes: 0 }]]),
        new Map([["eth0", { readBytes: 7000, writeBytes: 3000 }]]),
        2000,
      ),
    ).toEqual({ readBytes: 3000, writeBytes: 1500 });
  });

  it("drops a reading across a counter reset", () => {
    expect(
      counterRates(
        new Map([["eth0", { readBytes: 1000, writeBytes: 0 }]]),
        new Map([["eth0", { readBytes: 10, writeBytes: 10 }]]),
        1000,
      ),
    ).toBeNull();
  });

  it("compares only identities present in both readings", () => {
    const before = new Map([["md2", { readBytes: 1000, writeBytes: 1000 }]]);
    const after = new Map([
      ["md2", { readBytes: 4000, writeBytes: 1000 }],
      // Mounted between readings: its lifetime counters are not recent traffic.
      ["sdb", { readBytes: 512_000_000, writeBytes: 512_000_000 }],
    ]);
    expect(counterRates(before, after, 1000)).toEqual({ readBytes: 3000, writeBytes: 0 });
    expect(counterRates(after, new Map([["md2", { readBytes: 4000, writeBytes: 1000 }]]), 1000)).toEqual({
      readBytes: 0,
      writeBytes: 0,
    });
  });
});

describe("process files", () => {
  it("reads utime, stime, start time, and RSS", () => {
    const stat = parsePidStat(
      "2486439 (bash) S 2187496 2486439 2486439 0 -1 4194304 443 4020 0 0 7 3 1 1 20 0 1 0 7044010 7852032 1009 18446744073709551615 0",
    );
    expect(stat).toEqual({ pid: 2486439, name: "bash", cpuTicks: 10, startTicks: 7044010, rssPages: 1009 });
  });

  it("keeps parentheses and spaces inside the name", () => {
    const stat = parsePidStat(
      "42 (Web (Content) 2) S 1 42 42 0 -1 0 0 0 0 0 5 5 0 0 20 0 1 0 100 0 50 0",
    );
    expect(stat?.name).toBe("Web (Content) 2");
    expect(stat?.cpuTicks).toBe(10);
    expect(stat?.rssPages).toBe(50);
  });

  it("joins NUL-separated command lines", () => {
    expect(parseCmdline("node\0/usr/bin/claude\0--resume\0")).toBe("node /usr/bin/claude --resume");
  });
});

describe("small files", () => {
  it("reads load averages and uptime", () => {
    expect(parseLoadavg("12.31 10.05 9.80 3/2041 2486439\n")).toEqual([12.31, 10.05, 9.8]);
    expect(parseLoadavg("garbage")).toBeNull();
    expect(parseUptime("350735.47 33333.33\n")).toBe(350735.47);
  });
});
