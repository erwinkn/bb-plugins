/**
 * The host module: it runs on each enrolled machine and answers one call,
 * `sample`, by reading that machine's /proc, /sys, and statfs. The worker
 * keeps the previous counters between calls; BB stops it after five idle
 * minutes, which is also when nobody is looking at the gauge.
 */
import { readdir, readFile, statfs, access } from "node:fs/promises";
import os from "node:os";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract } from "./lib/contract.js";
import { createSampler, cpuTimesFromOs, type SystemReader } from "./lib/sampler.js";

const PAGE_SIZES = [4096, 16384, 65536];

/**
 * Bytes per page, from this process's own RSS in bytes against its RSS in
 * pages. Node exposes no getpagesize(); arm64 kernels use 4, 16, or 64 KiB.
 */
async function pageSize(): Promise<number> {
  try {
    const residentPages = Number((await readFile("/proc/self/statm", "utf8")).split(" ")[1]);
    const ratio = process.memoryUsage().rss / residentPages;
    return PAGE_SIZES.reduce((best, size) => (Math.abs(size - ratio) < Math.abs(best - ratio) ? size : best));
  } catch {
    return 4096;
  }
}

const nodeReader: SystemReader = {
  readText: (path) => readFile(path, "utf8").catch(() => null),
  listDir: (path) => readdir(path).catch(() => null),
  exists: (path) => access(path).then(() => true, () => false),
  statfs: (path) => statfs(path).catch(() => null),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  os: {
    platform: process.platform,
    hostname: () => os.hostname(),
    cpuTimes: () => cpuTimesFromOs(os.cpus()),
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    loadavg: () => os.loadavg() as [number, number, number],
    uptime: () => os.uptime(),
    pageSize,
  },
};

const sampler = createSampler(nodeReader);

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    sample: (input) => sampler.sample(input),
  },
});
