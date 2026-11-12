import { describe, expect, it } from "vitest";
import type { OkPage, PageInput, PoolerMetrics } from "../src/model";
import { buildPage } from "../src/page";
import type { PoolerStatsRow } from "../src/pooler";
import { priced, priceOf } from "../src/prices";
import { amount, emptyMetrics } from "../src/shared";
import { DAY, HOUR, T0, fakeDirectory, fakePooler, type Slice } from "./fixtures";

const WEIGHTS = { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 };
const M = 1_000_000;

const row = (key: PoolerStatsRow["key"], metrics: Partial<PoolerMetrics>): PoolerStatsRow => ({ key, metrics: { ...emptyMetrics(), ...metrics } });

describe("priced", () => {
  it("prices each token type at the model's list price", () => {
    // Opus 5.5: $4 input, $0.20 cache read, $5 / $8 cache writes, $20 output.
    const metrics = priced(row({ model: "claude-opus-5-5", kind: "native" }, { input: M, cacheRead: 10 * M, cacheWrite5m: M, cacheWrite1h: M, output: M }), WEIGHTS);
    expect(metrics).toMatchObject({ usdInput: 4, usdCacheRead: 2, usdCacheWrite5m: 5, usdCacheWrite1h: 8, usdOutput: 20, usdRefresh: 0, unpricedTokens: 0 });
    expect(amount(metrics, "dollars")).toBe(39);
  });

  it("counts a model without a list price, or a type its provider does not price, as unpriced tokens, not $0", () => {
    const unknown = priced(row({ model: "codex-auto-review", kind: "native" }, { input: 2 * M, cacheRead: 100_000, output: 5_000 }), WEIGHTS);
    expect(unknown).toMatchObject({ usdInput: 0, usdOutput: 0, unpricedTokens: 2_105_000 });
    expect(priced(row({ model: null, kind: "native" }, { input: 7 }), WEIGHTS).unpricedTokens).toBe(7);
    // OpenAI's page prices no 5m or 1h writes.
    const luna = priced(row({ model: "gpt-6-luna", kind: "advisor" }, { input: M, cacheWrite5m: 300 }), WEIGHTS);
    expect(luna).toMatchObject({ usdInput: 0.1, usdCacheWrite5m: 0, unpricedTokens: 300 });
  });

  it("prices a dated Claude id as its model", () => {
    expect(priceOf("claude-haiku-4-5-20251001")).toBe(priceOf("claude-haiku-4-5"));
    expect(priceOf("claude-haiku-4-5-2025")).toBeNull();
  });

  it("turns warming into dollars: a refresh's cost, and the avoided rewrites at their own TTL's write price", () => {
    const refresh = priced(row({ model: "claude-opus-5-5", kind: "refresh" }, { refreshes: 3, input: 1_000, cacheRead: 5 * M }), WEIGHTS);
    expect(refresh.usdRefresh).toBeCloseTo(0.004 + 1);
    // 1M tokens kept warm, 600K of them resumed at 5m and 400K at 1h: the Pooler weighs them at
    // 600K × (1.25 − 0.1) + 400K × (2 − 0.1). In Opus 5.5 dollars: 0.6 × $5 + 0.4 × $8 − 1 × $0.20.
    const resumed = priced(
      row({ model: "claude-opus-5-5", kind: "native" }, { rewritesAvoided: 4, rewriteTokensAvoided: M, savedInputEquivalent: 600_000 * 1.15 + 400_000 * 1.9 }),
      WEIGHTS,
    );
    expect(resumed.usdSaved).toBeCloseTo(6);
    expect(resumed.usdRefresh).toBe(0);
    // An unpriced model's savings stay out of the dollars.
    expect(priced(row({ model: "claude-unknown-9", kind: "native" }, { rewriteTokensAvoided: M, savedInputEquivalent: 1.15 * M }), WEIGHTS).usdSaved).toBe(0);
  });
});

describe("a page in dollars", () => {
  const slices: Slice[] = [
    // $4 + $1 = $5.
    { at: T0 + HOUR, thread: "thr_a", model: "claude-opus-5-5", metrics: { requests: 2, input: M, cacheRead: 5 * M, rewritesAvoided: 1, rewriteTokensAvoided: M, savedInputEquivalent: 1.15 * M } },
    // Warming: $0.40 of cache reads.
    { at: T0 + HOUR, thread: "thr_a", kind: "refresh", model: "claude-opus-5-5", metrics: { requests: 1, refreshes: 1, cacheRead: 2 * M } },
    // Far more tokens, but cheaper: $0.10 + $0.40 + $0.10.
    { at: T0 + 2 * HOUR, thread: "thr_b", provider: "codex", model: "gpt-6-luna", metrics: { requests: 1, input: M, cacheRead: 40 * M, output: 200_000 } },
    { at: T0 + 2 * HOUR, thread: "thr_b", provider: "codex", model: "codex-auto-review", metrics: { requests: 1, input: 2_000_000, output: 100_000 } },
  ];
  const input: PageInput = { from: T0, to: T0 + DAY, bucket: "hour", timeZone: "UTC", split: "model", measure: "dollars", filter: {} };

  const build = async (overrides: Partial<PageInput> = {}, extra: typeof slices = []) => {
    const pooler = fakePooler([...slices, ...extra]);
    const page = await buildPage({ ...input, ...overrides }, { pooler, directory: fakeDirectory({}), now: () => T0 + DAY });
    if (page.status !== "ok") throw new Error(page.reason);
    return { page: page as OkPage, pooler };
  };

  it("reads every group by model, the total by kind too, and folds them back to the group's own rows", async () => {
    const { page, pooler } = await build();
    expect(pooler.calls[0]?.groups[0]).toEqual(["model", "kind"]);
    expect(pooler.calls[0]?.groups.at(-1)).toEqual(["bucket", "model"]);
    expect(page.breakdowns.model).toHaveLength(3);
    expect(page.breakdowns.thread.map((item) => item.id)).toEqual(["thr_a", "thr_b"]);
    expect(page.series.buckets[1]?.metrics.requests).toBe(3);
  });

  it("totals the priced usage, counts the unpriced tokens beside it, and prices warming", async () => {
    const { page } = await build();
    expect(amount(page.totals, "dollars")).toBeCloseTo(5.4 + 0.6);
    expect(page.totals.unpricedTokens).toBe(2_100_000);
    expect(page.breakdowns.model.filter((item) => item.metrics.unpricedTokens > 0).map((item) => item.detail)).toEqual(["codex-auto-review"]);
    expect(page.totals.usdRefresh).toBeCloseTo(0.4);
    // 1M tokens resumed at 5m on Opus 5.5: $5 − $0.20.
    expect(page.totals.usdSaved).toBeCloseTo(4.8);
  });

  it("ranks breakdowns and the chart's series by dollars, not tokens", async () => {
    const { page } = await build();
    expect(page.breakdowns.model.map((item) => item.label)).toEqual(["Opus 5.5", "GPT-6 Luna", "codex-auto-review"]);
    expect(page.breakdowns.provider.map((item) => item.id)).toEqual(["claude", "codex"]);
    const series = page.series.keys.map((key, index) => [key.label, page.series.amounts[index]!.reduce((sum, value) => sum + value, 0)]);
    expect(series[0]?.[0]).toBe("Opus 5.5");
    expect(series[0]?.[1]).toBeCloseTo(5.4);
    expect(series[1]?.[1]).toBeCloseTo(0.6);
  });

  it("keeps a chart split by account within the Pooler's three dimensions per group", async () => {
    const { page, pooler } = await build({ split: "account" });
    expect(pooler.calls[0]?.groups.at(-1)).toEqual(["bucket", "account", "model"]);
    expect(amount(page.totals, "dollars")).toBeCloseTo(6);
    expect(page.totals.usdRefresh).toBeCloseTo(0.4);
    expect(page.series.amounts.flat().reduce((sum, value) => sum + value, 0)).toBeCloseTo(6);
  });

  it("lists rows and chart series at the same dollars, such as unpriced ones, by tokens", async () => {
    const { page } = await build({}, [
      { at: T0 + 3 * HOUR, thread: "thr_b", provider: "codex", model: null, metrics: { requests: 1, input: 9 * M } },
    ]);
    expect(page.breakdowns.model.slice(-2).map((item) => item.label)).toEqual(["Unknown model", "codex-auto-review"]);
    expect(page.series.keys.slice(-2).map((key) => key.label)).toEqual(["Unknown model", "codex-auto-review"]);
  });
});
