// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { resetQueryClient } from "../lib/query";
import type { ListResult } from "../src/schemas";

// How many RPCs an open settings page sends per minute: idle, under a stream
// of pushed lists, and in a hidden tab. A push carries the whole list into
// the cache, so it costs no read (and fresh data restarts the 60 s safety
// poll, so a busy stream reads nothing at all); the poll is the idle read.

const app = await loadPluginApp(() => import("../app"));
const MINUTES = 10;
const list = (revision: number): ListResult => ({ revision, reloadPending: false, servers: [] });
const rpc = { list: async () => list(1) };
let visibility: DocumentVisibilityState = "visible";
const slots: ReturnType<typeof renderSlot>[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  resetQueryClient();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
  for (const slot of slots.splice(0)) slot.unmount();
  cleanup();
  resetQueryClient();
  vi.useRealTimers();
  delete (document as { visibilityState?: unknown }).visibilityState;
});

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

async function measure(during: (slot: ReturnType<typeof renderSlot>) => Promise<void>) {
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc });
  slots.push(slot);
  // The mount's own read settles first; the rate counts the steady state.
  await advance(2_000);
  const start = slot.inspection.rpcCalls.length;
  for (let minute = 0; minute < MINUTES; minute++) await during(slot);
  return (slot.inspection.rpcCalls.length - start) / MINUTES;
}

describe("request rate of an open settings page", () => {
  it("idle, visible: the safety poll alone", async () => {
    expect(await measure(() => advance(60_000))).toBe(1);
  });

  it("a list pushed every 5 s costs no read, and holds off the poll", async () => {
    let revision = 2;
    const rate = await measure(async (slot) => {
      for (let s = 0; s < 60; s += 5) {
        await slot.behavior.emitRealtime("servers-changed", list(revision++));
        await advance(5_000);
      }
    });
    expect(rate).toBe(0);
  });

  it("hidden tab", async () => {
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    expect(await measure(() => advance(60_000))).toBe(0);
  });
});
