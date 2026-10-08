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
    { at: now - 2 * HOUR, model: "claude-opus-5-5", metrics: { requests: 12, inputEquivalent: 4_000, coldRewrites: 3, nativePromptTokens: 1_000, nativeCacheRead: 950 } },
    { at: now - 2 * HOUR, model: "claude-sonnet-5-5", metrics: { requests: 3, inputEquivalent: 1_000, nativePromptTokens: 100, nativeCacheRead: 50 } },
  ]);
  const inputs: PageInput[] = [];
  const slot = await page((input) => {
    inputs.push(input);
    return buildPage(input, { pooler, directory: fakeDirectory({}), now: () => now });
  });
  const cost = async () => (await slot.findByText("input-equivalent tokens")).parentElement!.textContent;
  expect(await cost()).toBe("Cost5,000input-equivalent tokens");
  expect(slot.getByText("Cache hit rate").parentElement!.textContent).toContain("90.9%");
  expect(inputs[0]).toMatchObject({ bucket: "day", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, split: "type", filter: {} });
  expect(inputs[0]!.to - inputs[0]!.from).toBe(7 * 24 * HOUR);

  const byModel = slot.getByRole("heading", { name: "By model" }).closest("section")!;
  fireEvent.click(within(byModel).getByText("Sonnet 5.5"));
  await waitFor(() => expect(inputs.at(-1)?.filter).toEqual({ model: "claude-sonnet-5-5" }));
  await waitFor(async () => expect(await cost()).toBe("Cost1,000input-equivalent tokens"));
  fireEvent.click(slot.getByRole("button", { name: "Clear filters" }));
  await waitFor(() => expect(inputs.at(-1)?.filter).toEqual({}));

  fireEvent.click(slot.getByRole("radio", { name: "24 hours" }));
  await waitFor(() => expect(inputs.at(-1)).toMatchObject({ bucket: "hour" }));
  expect(inputs.at(-1)!.to - inputs.at(-1)!.from).toBe(24 * HOUR);
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
  await slot.findByText("input-equivalent tokens");
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
  expect(await slot.findByText("input-equivalent tokens")).toBeTruthy();
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
