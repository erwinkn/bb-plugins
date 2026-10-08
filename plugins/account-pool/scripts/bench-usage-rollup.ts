// Benchmark of the usage rollup on a copy of a real ledger: the first build, step by step, a step
// against a held lock, and the queries a statistics page makes over 1, 7 and 30 days, before the
// build (a backlog) and after it (rolled-up hours plus the live edge). Every number is synchronous
// time, so the longest is the longest the event loop is blocked. Rebuilds the rollup tables in the
// given file: pass a copy, never the live data.db.
//
//   cp ~/.bb/plugins/account-pool-local/data.db /tmp/ledger-copy.db
//   npx tsx scripts/bench-usage-rollup.ts /tmp/ledger-copy.db
import Database from "better-sqlite3";
import { QUOTA_MIGRATIONS } from "../src/store.js";
import { queryUsageQuota, UsageRollup, usageStatsInputSchema } from "../src/usage-rollup.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const file = process.argv[2]!;
const db = new Database(file);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 0");
db.exec("DROP TABLE IF EXISTS usage_hourly; DROP TABLE IF EXISTS usage_rollup_cursor");
db.exec(QUOTA_MIGRATIONS.at(-1)!);
const { rows, last } = db.prepare("SELECT count(*) AS rows, max(at) AS last FROM usage_requests").get() as {
  rows: number;
  last: number;
};
const now = last + 60_000;
const rollup = new UsageRollup({ db, now: () => now, openSince: () => null, retentionDays: () => 365, log: console.log });
const time = <T>(run: () => T): [T, number] => {
  const start = performance.now();
  const result = run();
  return [result, performance.now() - start];
};
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

// Local calendar starts for Europe/Berlin, as the page sends them (hours here are UTC hours).
const dayStarts = (from: number) => {
  const starts: number[] = [];
  for (let at = Math.floor(from / DAY) * DAY - 2 * HOUR; at < now; at += DAY) starts.push(at);
  return starts;
};
const hourStarts = (from: number) => {
  const starts: number[] = [];
  for (let at = Math.floor(from / HOUR) * HOUR; at < now; at += HOUR) starts.push(at);
  return starts;
};
const pageQuery = (days: number) => {
  const from = now - days * DAY;
  return usageStatsInputSchema.parse({
    from,
    to: now,
    bucket: { starts: days === 1 ? hourStarts(from) : dayStarts(from) },
    filter: {},
    groups: [[], ["bucket"], ["bucket", "model"], ["provider"], ["model"], ["account"], ["role"], ["thread"], ["kind"]],
  });
};

console.log(`${rows} ledger rows over ${((last - (db.prepare("SELECT min(at) AS m FROM usage_requests").get() as { m: number }).m) / DAY).toFixed(1)} days`);
const [backlog, backlogMs] = time(() => rollup.stats(pageQuery(30)));
console.log(`30d page query before the build: ${backlogMs.toFixed(1)} ms, pendingRows ${backlog.pendingRows}`);

const other = new Database(file);
other.exec("BEGIN IMMEDIATE");
const busy = [0, 0, 0, 0, 0].map(() => time(() => rollup.step()));
other.exec("COMMIT");
other.close();
console.log(`step against a held lock: ${busy.map(([result]) => result).join(",")}, worst ${Math.max(...busy.map(([, ms]) => ms)).toFixed(2)} ms`);

let steps = 0;
let worst = 0;
const [, buildMs] = time(() => {
  for (;;) {
    const [result, ms] = time(() => rollup.step());
    steps += 1;
    worst = Math.max(worst, ms);
    if (result !== "behind") break;
  }
});
const cursor = db.prepare("SELECT at FROM usage_rollup_cursor").get() as { at: number };
const liveRows = (db.prepare("SELECT count(*) AS n FROM usage_requests WHERE at > ?").get(cursor.at) as { n: number }).n;
console.log(`build: ${buildMs.toFixed(0)} ms in ${steps} steps of up to 2,000 rows, worst step ${worst.toFixed(1)} ms`);
console.log(`rollup rows ${(db.prepare("SELECT count(*) AS n FROM usage_hourly").get() as { n: number }).n}; live edge ${liveRows} rows`);
const idle = [0, 0, 0, 0, 0].map(() => time(() => rollup.step())[1]);
console.log(`caught-up step: worst ${Math.max(...idle).toFixed(2)} ms`);

for (const days of [1, 7, 30]) {
  const input = pageQuery(days);
  const runs: number[] = [];
  let result;
  for (let index = 0; index < 7; index += 1) {
    const [value, ms] = time(() => rollup.stats(input));
    result = value;
    runs.push(ms);
  }
  const quota = [0, 0, 0, 0, 0].map(() => time(() => queryUsageQuota(db, { from: now - days * DAY, to: now }))[1]);
  console.log(
    `${days}d page query (9 groups): median ${median(runs.slice()).toFixed(1)} ms, worst ${Math.max(...runs).toFixed(1)} ms; ` +
      `rows per group ${result!.results.map((group) => group.length).join(",")}; quota median ${median(quota).toFixed(1)} ms`,
  );
}
const total = rollup.stats(usageStatsInputSchema.parse({ from: 0, to: now, bucket: null, filter: {}, groups: [[]] }));
console.log(JSON.stringify(total.results[0]![0]!.metrics));
