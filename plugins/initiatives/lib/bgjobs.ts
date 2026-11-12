import { execFile } from "node:child_process";

/**
 * W606: the long jobs agents run with `~/.bb/bin/bgjob` (D591). Each is a transient systemd user
 * service named `bgjob-<thread>-<UTC start, YYYYMMDDTHHMMSSZ>-<pid>`, which stays active until
 * the job has exited and its thread has been told (bgjob retries that message for ~30 min). So a
 * thread with an active unit waits on a wake as surely as one with a live child: the stuck-worker
 * sweep leaves it alone.
 */
export type Bgjobs = ReadonlyMap<string, number>;

const UNIT = /^bgjob-(.+)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-\d+\.service$/;

/** The newest start of each thread's active bgjob units, from `systemctl list-units` output. */
export function parseBgjobUnits(output: string): Map<string, number> {
  const jobs = new Map<string, number>();
  for (const line of output.split("\n")) {
    const m = UNIT.exec(line.trim().split(/\s+/)[0] ?? "");
    if (!m) continue;
    const [, thread, y, mo, d, h, mi, s] = m;
    const start = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!);
    jobs.set(thread!, Math.max(start, jobs.get(thread!) ?? -Infinity));
  }
  return jobs;
}

/**
 * The active bgjob units by thread. Rejects when systemd can't be asked (another OS, no user
 * manager, a timeout): the sweep then flags as it did before bgjob existed.
 */
export function runningBgjobs(): Promise<Bgjobs> {
  return new Promise((resolve, reject) => {
    execFile(
      "systemctl",
      ["--user", "list-units", "--plain", "--no-legend", "--no-pager", "--type=service", "--state=active,activating,deactivating", "bgjob-*"],
      { timeout: 5_000, maxBuffer: 1 << 20 },
      (error, stdout) => (error ? reject(error) : resolve(parseBgjobUnits(stdout))),
    );
  });
}
