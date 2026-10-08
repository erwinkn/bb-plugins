// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PageInput } from "../src/model";
import { buildPage } from "../src/page";
import { HOUR, fakeDirectory, fakePooler } from "./fixtures";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

async function page(handler: (input: PageInput) => unknown) {
  const app = await loadPluginApp(() => import("../app"));
  const panel = app.navPanels[0];
  if (panel === undefined) throw new Error("missing page");
  expect(panel).toMatchObject({ id: "usage", title: "Usage", path: "usage" });
  return renderSlot(panel, { subPath: "" }, { rpc: { page: handler as never } });
}

it("shows the slice's numbers, and narrows every one of them from a breakdown row", async () => {
  const now = Date.now();
  const pooler = fakePooler([
    { at: now - 2 * HOUR, model: "claude-opus-5-5", metrics: { requests: 12, input: 50, cacheRead: 950, inputEquivalent: 4_000, coldRewrites: 3, nativePromptTokens: 1_000, nativeCacheRead: 950 } },
    { at: now - 2 * HOUR, model: "claude-sonnet-5-5", metrics: { requests: 3, input: 50, cacheRead: 50, inputEquivalent: 1_000, nativePromptTokens: 100, nativeCacheRead: 50 } },
  ]);
  const inputs: PageInput[] = [];
  const slot = await page((input) => {
    inputs.push(input);
    return buildPage(input, { pooler, directory: fakeDirectory({}), now: () => now });
  });
  const headline = async () => (await slot.findByText("Tokens processed")).parentElement!.textContent;
  expect(await headline()).toBe("Tokens processed1,10091% cache reads");
  expect(slot.getByText("Cache hit rate").parentElement!.textContent).toContain("90.9%");
  expect(inputs[0]).toMatchObject({ bucket: "day", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, split: "type", measure: "tokens", filter: {} });
  expect(inputs[0]!.to - inputs[0]!.from).toBe(7 * 24 * HOUR);

  const byModel = slot.getByRole("heading", { name: "By model" }).closest("section")!;
  fireEvent.click(within(byModel).getByText("Sonnet 5.5"));
  await waitFor(() => expect(inputs.at(-1)?.filter).toEqual({ model: "claude-sonnet-5-5" }));
  await waitFor(async () => expect(await headline()).toBe("Tokens processed10050% cache reads"));
  fireEvent.click(slot.getByRole("button", { name: "Clear filters" }));
  await waitFor(() => expect(inputs.at(-1)?.filter).toEqual({}));

  fireEvent.click(slot.getByRole("radio", { name: "24 hours" }));
  await waitFor(() => expect(inputs.at(-1)).toMatchObject({ bucket: "hour" }));
  expect(inputs.at(-1)!.to - inputs.at(-1)!.from).toBe(24 * HOUR);
});

it("measures in raw tokens by default, switches to price-weighted cost, and remembers the choice", async () => {
  const now = Date.now();
  const start = now - 2 * HOUR;
  const pooler = fakePooler([
    { at: start, metrics: { requests: 2, input: 1_000, cacheRead: 90_000, cacheWrite5m: 8_000, cacheWrite1h: 0, output: 1_000, inputEquivalent: 24_000 } },
  ]);
  const inputs: PageInput[] = [];
  const handler = (input: PageInput) => {
    inputs.push(input);
    return buildPage(input, { pooler, directory: fakeDirectory({}), now: () => now });
  };
  let slot = await page(handler);
  expect((await slot.findByText("Tokens processed")).parentElement!.textContent).toBe("Tokens processed100K90% cache reads");
  expect(slot.getByRole("heading", { name: "Tokens over time" })).toBeTruthy();
  const byModel = () => slot.getByRole("heading", { name: "By model" }).closest("section")!;
  expect(within(byModel()).getByRole("columnheader", { name: "Tokens" })).toBeTruthy();
  const ledger = slot.getByText(/request ledger/).textContent!;
  expect(ledger).toContain(`which starts ${new Date(start).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`);
  expect(ledger).toContain("so this range has no data before then");

  fireEvent.click(within(slot.getByRole("radiogroup", { name: "Measure" })).getByRole("radio", { name: "Cost" }));
  expect((await slot.findByText("price-weighted tokens")).parentElement!.textContent).toBe("Cost24Kprice-weighted tokens");
  expect(inputs.at(-1)?.measure).toBe("cost");
  expect(slot.getByRole("heading", { name: "Cost over time" })).toBeTruthy();
  expect(within(byModel()).getByRole("columnheader", { name: "Cost" })).toBeTruthy();
  expect(slot.queryByText("Tokens processed")).toBeNull();

  // A later visit opens in the measure last chosen.
  cleanup();
  slot = await page(handler);
  expect(await slot.findByText("price-weighted tokens")).toBeTruthy();
  expect(inputs.at(-1)?.measure).toBe("cost");
});

it("keeps the chart in the measure its data came in until the new measure's data arrives", async () => {
  window.localStorage.setItem("usage-stats.split", JSON.stringify("model"));
  const now = Date.now();
  const pooler = fakePooler([
    { at: now - 2 * HOUR, model: "claude-opus-5-5", metrics: { requests: 2, input: 1_000, cacheRead: 90_000, cacheWrite5m: 8_000, output: 1_000, inputEquivalent: 24_000 } },
  ]);
  let held: { resolve: (page: unknown) => void; reject: (error: Error) => void; input: PageInput } | null = null;
  const slot = await page((input) =>
    input.measure === "tokens"
      ? buildPage(input, { pooler, directory: fakeDirectory({}), now: () => now })
      : new Promise((resolve, reject) => (held = { resolve, reject, input })),
  );
  const chart = (measure: string) => {
    const card = slot.getByRole("heading", { name: `${measure} over time` }).closest("section")!;
    return within(card).getByText("Opus 5.5").parentElement!.textContent;
  };
  const headline = () => slot.getByText(/^(\S+ cache reads|price-weighted tokens)$/u).parentElement!.textContent;
  await slot.findByText("Tokens processed");
  expect(chart("Tokens")).toBe("Opus 5.5100K · 100%");
  const measure = (name: string) => fireEvent.click(within(slot.getByRole("radiogroup", { name: "Measure" })).getByRole("radio", { name }));

  // While the cost is on its way, the page still shows tokens throughout.
  measure("Cost");
  await waitFor(() => expect(held).not.toBeNull());
  expect(chart("Tokens")).toBe("Opus 5.5100K · 100%");
  expect(headline()).toBe("Tokens processed100K90% cache reads");
  held!.resolve(await buildPage(held!.input, { pooler, directory: fakeDirectory({}), now: () => now }));
  await waitFor(() => expect(chart("Cost")).toBe("Opus 5.524K · 100%"));
  expect(headline()).toBe("Cost24Kprice-weighted tokens");

  // A failed request leaves the last page as it was, not relabeled.
  measure("Tokens");
  await waitFor(() => expect(chart("Tokens")).toBe("Opus 5.5100K · 100%"));
  held = null;
  measure("Cost");
  await waitFor(() => expect(held).not.toBeNull());
  held!.reject(new Error("Pooler down"));
  await waitFor(() => expect(slot.getByRole("radio", { name: "Cost" }).getAttribute("aria-checked")).toBe("true"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(chart("Tokens")).toBe("Opus 5.5100K · 100%");
  expect(headline()).toBe("Tokens processed100K90% cache reads");
});

it("restores the range, resolution and filters on a later visit; a relative range stays relative", async () => {
  const now = Date.now();
  const pooler = fakePooler([{ at: now - 2 * HOUR, model: "claude-sonnet-5-5", metrics: { requests: 1, input: 10 } }]);
  const inputs: PageInput[] = [];
  const handler = (input: PageInput) => {
    inputs.push(input);
    return buildPage(input, { pooler, directory: fakeDirectory({}), now: () => now });
  };
  let slot = await page(handler);
  await slot.findByText("Tokens processed");
  fireEvent.click(slot.getByRole("radio", { name: "30 days" }));
  fireEvent.click(slot.getByRole("radio", { name: "Hourly" }));
  const byModel = slot.getByRole("heading", { name: "By model" }).closest("section")!;
  fireEvent.click(within(byModel).getByText("Sonnet 5.5"));
  await waitFor(() => expect(inputs.at(-1)).toMatchObject({ bucket: "hour", filter: { model: "claude-sonnet-5-5" } }));

  // A relative range ends at the time of the visit, not at the time it was chosen.
  cleanup();
  inputs.length = 0;
  slot = await page(handler);
  await waitFor(() => expect(inputs[0]).toMatchObject({ bucket: "hour", filter: { model: "claude-sonnet-5-5" } }));
  expect(inputs[0]!.to - inputs[0]!.from).toBe(30 * 24 * HOUR);
  expect(inputs[0]!.to).toBeGreaterThanOrEqual(now);
  fireEvent.click(await slot.findByRole("button", { name: "Clear filters" }));
  await waitFor(() => expect(inputs.at(-1)?.filter).toEqual({}));

  // A custom range keeps its dates.
  fireEvent.click(slot.getByRole("radio", { name: "Custom" }));
  fireEvent.change(slot.getByLabelText("From"), { target: { value: "2026-01-01" } });
  fireEvent.change(slot.getByLabelText("To"), { target: { value: "2026-01-02" } });
  cleanup();
  inputs.length = 0;
  slot = await page(handler);
  await waitFor(() => expect(inputs[0]?.from).toBe(new Date("2026-01-01T00:00").getTime()));
  expect(inputs[0]).toMatchObject({ to: new Date(2026, 0, 3).getTime(), filter: {} });
  expect((slot.getByLabelText("From") as HTMLInputElement).value).toBe("2026-01-01");
});

it("starts from the defaults when what the browser stored is no longer valid", async () => {
  window.localStorage.setItem("usage-stats.range", JSON.stringify({ preset: "90d", customFrom: "x", customTo: "y" }));
  window.localStorage.setItem("usage-stats.filter", JSON.stringify({ planet: "mars" }));
  window.localStorage.setItem("usage-stats.measure", "not json");
  const inputs: PageInput[] = [];
  const now = Date.now();
  await page((input) => {
    inputs.push(input);
    return buildPage(input, { pooler: fakePooler([]), directory: fakeDirectory({}), now: () => now });
  });
  await waitFor(() => expect(inputs[0]).toMatchObject({ bucket: "day", measure: "tokens", filter: {} }));
  expect(inputs[0]!.to - inputs[0]!.from).toBe(7 * 24 * HOUR);
});

it("drops a stored custom range the page cannot ask for", async () => {
  const day = (offset: number) => {
    const date = new Date(Date.now() + offset * 24 * HOUR);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const now = Date.now();
  for (const [customFrom, customTo] of [
    // Not on the calendar, reversed, wholly in the future, and over 400 days.
    ["2026-02-30", "2026-03-03"],
    ["2026-01-05", "2026-01-01"],
    [day(10), day(11)],
    ["2020-01-01", "2026-01-01"],
  ]) {
    window.localStorage.setItem("usage-stats.range", JSON.stringify({ preset: "custom", customFrom, customTo }));
    const inputs: PageInput[] = [];
    const slot = await page((input) => {
      inputs.push(input);
      return buildPage(input, { pooler: fakePooler([]), directory: fakeDirectory({}), now: () => now });
    });
    await waitFor(() => expect(inputs).toHaveLength(1));
    expect(inputs[0]!.to - inputs[0]!.from).toBe(7 * 24 * HOUR);
    expect(slot.getByRole("radio", { name: "7 days" }).getAttribute("aria-checked")).toBe("true");
    expect(JSON.parse(window.localStorage.getItem("usage-stats.range")!)).toMatchObject({ preset: "7d" });
    cleanup();
  }
});

it("explains where the numbers come from when the Account Pooler is missing", async () => {
  const slot = await page(() => ({ status: "unavailable", reason: "The Account Pooler (account-pool-local) did not answer." }));
  expect(await slot.findByText(/request ledger/)).toBeTruthy();
});

it("says the page failed instead of loading forever when the first call fails", async () => {
  const slot = await page(() => Promise.reject(new Error("Unknown method usage.stats")));
  expect((await slot.findByRole("alert")).textContent).toBe("Usage could not be loaded: Unknown method usage.stats");
  expect(slot.queryByText("Loading usage…")).toBeNull();
});

it("asks again on Refresh, even when the range has not changed", async () => {
  const now = Date.now();
  const pooler = fakePooler([{ at: now - 2 * HOUR, metrics: { requests: 1, inputEquivalent: 10 } }]);
  let calls = 0;
  const slot = await page((input) => {
    calls += 1;
    return buildPage(input, { pooler, directory: fakeDirectory({}), now: () => now });
  });
  await slot.findByText("Tokens processed");
  // A historical custom range: the same input on every click.
  fireEvent.click(slot.getByRole("radio", { name: "Custom" }));
  fireEvent.change(slot.getByLabelText("From"), { target: { value: "2026-01-01" } });
  fireEvent.change(slot.getByLabelText("To"), { target: { value: "2026-01-02" } });
  await waitFor(() => expect(slot.getByRole("status").textContent).toContain("No requests in this range"));
  const before = calls;
  fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(calls).toBe(before + 1));
  fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(calls).toBe(before + 2));
});

it("says the ledger is still being counted rather than empty, and asks again until it is done", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const now = Date.now();
  const counted = fakePooler([{ at: now - 2 * HOUR, metrics: { requests: 4, inputEquivalent: 40 } }]);
  const counting = fakePooler([]);
  const stats = counting.stats.bind(counting);
  counting.stats = async (input) => ({ ...(await stats(input)), pendingRows: 10_001 });
  let calls = 0;
  const slot = await page((input) => {
    calls += 1;
    return buildPage(input, { pooler: calls === 1 ? counting : counted, directory: fakeDirectory({}), now: () => now });
  });
  expect((await slot.findByText(/Still counting/)).textContent).toBe("Still counting 10,001 requests from the ledger…");
  expect(slot.queryByText(/No requests/)).toBeNull();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(await slot.findByText("Tokens processed")).toBeTruthy();
  expect(slot.queryByText(/Still counting/)).toBeNull();
  expect(calls).toBe(2);
});

it("ends a custom range at the local midnight after its last day, by the calendar", async () => {
  const { rangeOf } = await import("../app/page");
  const zone = process.env.TZ;
  process.env.TZ = "Europe/Berlin";
  try {
    // March 29 2026 has 23 hours in Berlin.
    expect(rangeOf({ preset: "custom", customFrom: "2026-03-28", customTo: "2026-03-29" }, Date.UTC(2026, 3, 1))).toEqual({
      from: Date.UTC(2026, 2, 27, 23),
      to: Date.UTC(2026, 2, 29, 22),
    });
    // Santiago skips midnight on September 6: that day starts at 01:00 -03:00, the next at 00:00.
    process.env.TZ = "America/Santiago";
    expect(rangeOf({ preset: "custom", customFrom: "2026-09-06", customTo: "2026-09-06" }, Date.UTC(2026, 9, 1))).toEqual({
      from: Date.UTC(2026, 8, 6, 4),
      to: Date.UTC(2026, 8, 7, 3),
    });
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});
