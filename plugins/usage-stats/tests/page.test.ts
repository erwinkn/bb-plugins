import { describe, expect, it } from "vitest";
import type { PageInput, OkPage } from "../src/model";
import type { PoolerQuota } from "../src/pooler";
import { bucketEnd, bucketStarts, dayStart } from "../src/calendar";
import { buildPage, downsample, modelName } from "../src/page";
import { OTHER_ID } from "../src/shared";
import { DAY, HOUR, T0, fakeDirectory, fakePooler, type Slice } from "./fixtures";

function input(overrides: Partial<PageInput> = {}): PageInput {
  return { from: T0, to: T0 + DAY, bucket: "hour", timeZone: "UTC", split: "type", measure: "cost", filter: {}, ...overrides };
}

const slices: Slice[] = [
  { at: T0 + HOUR, thread: "thr_coord", role: "coordinator", metrics: { requests: 10, inputEquivalent: 1_000, nativePromptTokens: 100, nativeCacheRead: 90 } },
  { at: T0 + HOUR, thread: "thr_w1", account: "acct-b", metrics: { requests: 5, inputEquivalent: 3_000, coldRewrites: 2 } },
  { at: T0 + 3 * HOUR, thread: "thr_other", model: "claude-sonnet-5-5", metrics: { requests: 1, inputEquivalent: 500 } },
  { at: T0 + 3 * HOUR, thread: null, role: null, model: "claude-haiku-5-5", metrics: { requests: 7, inputEquivalent: 200 } },
  { at: T0 + 5 * HOUR, provider: "codex", model: "gpt-6-luna", account: "acct-x", thread: "thr_w1", metrics: { requests: 4 } },
];

const directory = () =>
  fakeDirectory(
    {
      thr_coord: { title: "bb-plugins · coordinator", projectId: "proj_bb" },
      thr_w1: { title: "W219 Usage stats", projectId: "proj_bb" },
      thr_other: { title: "Side quest", projectId: "proj_side" },
    },
    {
      thr_coord: { initiativeId: "prj_1", initiativeName: "bb-plugins", member: "Coordinator" },
      thr_w1: { initiativeId: "prj_1", initiativeName: "bb-plugins", member: "W219" },
    },
    { proj_bb: "bb-plugins", proj_side: "side" },
  );

async function ok(page: ReturnType<typeof buildPage>): Promise<OkPage> {
  const result = await page;
  if (result.status !== "ok") throw new Error(result.reason);
  return result;
}

describe("buildPage", () => {
  it("answers an unfiltered page with one Pooler call, named breakdowns and every filter's values", async () => {
    const pooler = fakePooler(slices);
    const page = await ok(buildPage(input(), { pooler, directory: directory(), now: () => T0 + DAY }));
    expect(pooler.calls).toHaveLength(1);
    expect(page.totals).toMatchObject({ requests: 27, inputEquivalent: 4_700, coldRewrites: 2 });
    expect(page.breakdowns.account.map((row) => [row.label, row.metrics.inputEquivalent])).toEqual([
      ["Erwin", 3_000],
      ["a@example.com", 1_700],
      ["Removed account acct-x", 0],
    ]);
    expect(page.breakdowns.model.map((row) => row.label)).toEqual(["Opus 5.5", "Sonnet 5.5", "Haiku 5.5", "GPT-6 Luna"]);
    expect(page.breakdowns.role.find((row) => row.id === "")?.label).toBe("Not linked");
    // Projects and Initiatives are sums of their threads; requests outside any thread have neither.
    expect(page.breakdowns.project.map((row) => [row.label, row.metrics.requests])).toEqual([
      ["bb-plugins", 19],
      ["side", 1],
      ["Unattributed", 7],
    ]);
    expect(page.breakdowns.initiative.map((row) => [row.label, row.metrics.requests])).toEqual([
      ["bb-plugins", 19],
      ["No Initiative", 8],
    ]);
    expect(page.breakdowns.thread[0]).toMatchObject({ label: "W219 Usage stats", detail: "bb-plugins · W219" });
    expect(page.breakdowns.threadCount).toBe(4);
    expect(page.options.project.map((option) => option.label)).toEqual(["bb-plugins", "side", "Unattributed"]);
    expect(page.series.buckets).toHaveLength(24);
    expect(page.series.buckets[1]?.metrics.requests).toBe(15);
  });

  it("turns a project or Initiative filter into the threads in it, and keeps the options unfiltered", async () => {
    const pooler = fakePooler(slices);
    const page = await ok(buildPage(input({ filter: { project: "proj_bb", provider: "claude" } }), { pooler, directory: directory(), now: () => T0 + DAY }));
    expect(pooler.calls).toHaveLength(2);
    expect(pooler.calls[1]?.filter).toEqual({ provider: ["claude"], thread: ["thr_coord", "thr_w1"] });
    expect(page.totals.requests).toBe(15);
    expect(page.options.provider.map((option) => option.id).sort()).toEqual(["claude", "codex"]);

    // "" is the requests outside any thread, and threads without a project.
    const unattributed = await ok(buildPage(input({ filter: { project: "" } }), { pooler, directory: directory(), now: () => T0 + DAY }));
    expect(unattributed.totals.requests).toBe(7);
    const noInitiative = await ok(buildPage(input({ filter: { initiative: "" }, bucket: "day" }), { pooler, directory: directory(), now: () => T0 + DAY }));
    expect(noInitiative.totals.requests).toBe(8);
  });

  it("splits the series by a dimension's top values and folds the rest into Other", async () => {
    const many: Slice[] = Array.from({ length: 8 }, (_, index) => ({
      at: T0 + index * HOUR,
      model: `model-${index}`,
      metrics: { requests: 1, inputEquivalent: 100 * (index + 1) },
    }));
    const page = await ok(buildPage(input({ split: "model" }), { pooler: fakePooler(many), directory: directory(), now: () => T0 + DAY }));
    expect(page.series.keys.map((key) => key.id)).toEqual(["model-7", "model-6", "model-5", "model-4", "model-3", OTHER_ID]);
    // Other holds models 0–2: 100 + 200 + 300.
    expect(page.series.amounts[5]?.reduce((sum, value) => sum + value, 0)).toBe(600);
    expect(page.series.requests[0]?.[7]).toBe(1);
  });

  it("ranks breakdowns and series by the measure: raw tokens rank a cache-heavy model above a pricier one", async () => {
    const usage: Slice[] = [
      // 1M tokens, mostly cache reads: 194K input-equivalents.
      { at: T0 + HOUR, model: "claude-sonnet-5-5", metrics: { requests: 1, input: 50_000, cacheRead: 940_000, output: 10_000, inputEquivalent: 194_000 } },
      // 100K tokens, mostly output: 420K input-equivalents.
      { at: T0 + HOUR, model: "claude-opus-5-5", metrics: { requests: 1, input: 20_000, cacheWrite5m: 0, output: 80_000, inputEquivalent: 420_000 } },
    ];
    const ranked = async (measure: PageInput["measure"]) => {
      const page = await ok(buildPage(input({ measure, split: "model" }), { pooler: fakePooler(usage), directory: directory(), now: () => T0 + DAY }));
      return {
        models: page.breakdowns.model.map((row) => row.label),
        series: page.series.keys.map((key, index) => [key.label, page.series.amounts[index]?.reduce((sum, value) => sum + value, 0)]),
      };
    };
    expect(await ranked("tokens")).toEqual({
      models: ["Sonnet 5.5", "Opus 5.5"],
      series: [["Sonnet 5.5", 1_000_000], ["Opus 5.5", 100_000]],
    });
    expect(await ranked("cost")).toEqual({
      models: ["Opus 5.5", "Sonnet 5.5"],
      series: [["Opus 5.5", 420_000], ["Sonnet 5.5", 194_000]],
    });
  });

  it("reports quota per account: resets when a window rolled over, ignoring jitter, removed accounts last", async () => {
    const quota: PoolerQuota = {
      accounts: [
        {
          accountId: "acct-gone",
          points: [{ at: T0, windows: { "5h": { utilization: 0.5, resetAt: T0 + HOUR } } }],
        },
        // Removed before the range: nothing to draw.
        { accountId: "acct-older", points: [{ at: T0 - HOUR, windows: { "5h": { utilization: 0.5, resetAt: null } } }] },
        {
          accountId: "acct-a",
          points: [
            { at: T0 - HOUR, windows: { "5h": { utilization: 0.9, resetAt: T0 + 2 * HOUR }, secondary: { utilization: 0, resetAt: T0 } } },
            // The same window read again, its reset a few seconds off.
            { at: T0 + HOUR, windows: { "5h": { utilization: 0.95, resetAt: T0 + 2 * HOUR + 4_000 } } },
            { at: T0 + 3 * HOUR, windows: { "5h": { utilization: 0.1, resetAt: T0 + 7 * HOUR } } },
          ],
        },
      ],
    };
    const page = await ok(buildPage(input(), { pooler: fakePooler(slices, { quota }), directory: directory(), now: () => T0 + DAY }));
    expect(page.quota.map((account) => [account.label, account.status, account.active])).toEqual([
      ["a@example.com", "ready", true],
      ["Removed account acct-gon", null, false],
    ]);
    expect(page.quota[0]?.windows).toEqual([
      {
        name: "5h",
        // The state at the range start is drawn from the start.
        points: [[T0, 0.9], [T0 + HOUR, 0.95], [T0 + 3 * HOUR, 0.1]],
        resets: [T0 + 2 * HOUR + 4_000],
      },
    ]);
  });

  it("lays the series on the browser's calendar and asks the Pooler for the same buckets", async () => {
    // Berlin, March 28 to 29 2026: the second day has 23 hours.
    const from = Date.UTC(2026, 2, 27, 23);
    const to = Date.UTC(2026, 2, 29, 22);
    const pooler = fakePooler([
      { at: Date.UTC(2026, 2, 28, 22), metrics: { requests: 1 } },
      { at: Date.UTC(2026, 2, 28, 23), metrics: { requests: 2 } },
    ]);
    const page = await ok(buildPage(input({ from, to, bucket: "day", timeZone: "Europe/Berlin" }), { pooler, directory: directory(), now: () => to }));
    expect(page.series.buckets.map((bucket) => [bucket.at, bucket.metrics.requests])).toEqual([
      [from, 1],
      [Date.UTC(2026, 2, 28, 23), 2],
    ]);
    expect(pooler.calls[0]?.bucket).toEqual({ starts: page.series.buckets.map((bucket) => bucket.at) });
    // The last day ends 23 hours after it starts, where the chart ends too.
    expect(page.series.end).toBe(Date.UTC(2026, 2, 29, 22));
    // October 25 lasts 25 hours.
    expect(bucketEnd(Date.UTC(2026, 9, 24, 22), "day", "Europe/Berlin")).toBe(Date.UTC(2026, 9, 25, 23));
  });

  it("keeps the usage of a half-hour zone's first hour in the first bucket", async () => {
    // Kolkata's day starts at 18:30 UTC; the Pooler's hour from 18:00 counts whole, in that day.
    const from = Date.UTC(2026, 9, 6, 18, 30);
    const pooler = fakePooler([{ at: Date.UTC(2026, 9, 6, 18), metrics: { requests: 1 } }]);
    const page = await ok(buildPage(input({ from, to: from + DAY, bucket: "day", timeZone: "Asia/Kolkata" }), { pooler, directory: directory(), now: () => from + DAY }));
    expect(page.totals.requests).toBe(1);
    expect(page.series.buckets.map((bucket) => [bucket.at, bucket.metrics.requests])).toEqual([[from, 1]]);
  });

  it("scopes quota cards to the account and provider filters", async () => {
    const window = { "5h": { utilization: 0.5, resetAt: T0 + HOUR } };
    const quota: PoolerQuota = {
      accounts: ["acct-a", "acct-b"].map((accountId) => ({ accountId, points: [{ at: T0, windows: window }] })),
    };
    const build = async (filter: PageInput["filter"]) =>
      (await ok(buildPage(input({ filter }), { pooler: fakePooler(slices, { quota }), directory: directory(), now: () => T0 + DAY }))).quota.map(
        (account) => account.accountId,
      );
    expect(await build({})).toEqual(["acct-a", "acct-b"]);
    expect(await build({ account: "acct-b" })).toEqual(["acct-b"]);
    expect(await build({ provider: "codex" })).toEqual([]);
    // Quota is account-wide: a model filter leaves every card.
    expect(await build({ model: "claude-opus-5-5" })).toEqual(["acct-a", "acct-b"]);
  });

  it("says why when the Account Pooler does not answer", async () => {
    const page = await buildPage(input(), { pooler: fakePooler([], { status: new Error('Plugin "account-pool-local" is not installed.') }), directory: directory(), now: () => T0 });
    expect(page).toEqual({ status: "unavailable", reason: expect.stringContaining("not installed") });
  });
});

describe("helpers", () => {
  it("names models", () => {
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelName("claude-fable-5-1")).toBe("Fable 5.1");
    expect(modelName("claude-opus-5")).toBe("Opus 5");
    expect(modelName("gpt-6.1-sol")).toBe("GPT-6.1 Sol");
    expect(modelName("gpt-6-luna")).toBe("GPT-6 Luna");
    expect(modelName("o3-mini")).toBe("o3-mini");
  });

  it("starts days at local midnight by the calendar, across DST changes", () => {
    const berlin = (from: number, to: number, bucket: "hour" | "day" = "day") =>
      bucketStarts({ from, to, bucket, timeZone: "Europe/Berlin" });
    // March 29 2026 has 23 hours; a custom range from March 28 to 30 ends at March 31 00:00 +02:00.
    expect(berlin(Date.UTC(2026, 2, 27, 23), Date.UTC(2026, 2, 30, 22))).toEqual([
      Date.UTC(2026, 2, 27, 23),
      Date.UTC(2026, 2, 28, 23),
      Date.UTC(2026, 2, 29, 22),
    ]);
    // October 25 has 25 hours, and 02:00 twice.
    expect(berlin(Date.UTC(2026, 9, 24, 22), Date.UTC(2026, 9, 26, 23))).toEqual([Date.UTC(2026, 9, 24, 22), Date.UTC(2026, 9, 25, 23)]);
    expect(berlin(Date.UTC(2026, 9, 24, 23), Date.UTC(2026, 9, 25, 3), "hour")).toHaveLength(4);
    // Santiago skips midnight on September 6: that day starts at 01:00.
    expect(bucketStarts({ from: Date.UTC(2026, 8, 5, 12), to: Date.UTC(2026, 8, 7), bucket: "day", timeZone: "America/Santiago" })).toEqual([
      Date.UTC(2026, 8, 5, 4),
      Date.UTC(2026, 8, 6, 4),
    ]);
    // Havana falls back from 01:00 to 00:00 on November 1: that day starts at the first midnight.
    expect(bucketStarts({ from: Date.UTC(2026, 9, 31, 12), to: Date.UTC(2026, 10, 2, 12), bucket: "day", timeZone: "America/Havana" })).toEqual([
      Date.UTC(2026, 9, 31, 4),
      Date.UTC(2026, 10, 1, 4),
      Date.UTC(2026, 10, 2, 5),
    ]);
    expect(dayStart(Date.UTC(2026, 10, 1, 4, 30), "America/Havana")).toBe(Date.UTC(2026, 10, 1, 4));
    expect(dayStart(Date.UTC(2026, 10, 1, 5, 30), "America/Havana")).toBe(Date.UTC(2026, 10, 1, 4));
    // Kolkata's hours start at half past the UTC hour.
    expect(bucketStarts({ from: Date.UTC(2026, 9, 6, 18, 40), to: Date.UTC(2026, 9, 6, 20), bucket: "hour", timeZone: "Asia/Kolkata" })).toEqual([
      Date.UTC(2026, 9, 6, 18, 30),
      Date.UTC(2026, 9, 6, 19, 30),
    ]);
  });

  it("downsamples to the highest value per slot", () => {
    const points = Array.from({ length: 1_000 }, (_, index) => [index, index === 500 ? 1 : 0.2] as [number, number]);
    const result = downsample(points, 0, 1_000);
    expect(result.length).toBeLessThanOrEqual(300);
    expect(result).toContainEqual([500, 1]);
    expect(result.filter(([, value]) => value === 1)).toHaveLength(1);
  });
});
