// A230 regressions (transports, budgets, Settings): cancellation before a
// POST, Jev's whole-body cap, the pooled Luna stream, budget time-zone
// changes and invalid stored values. Fake fetch and fake host only.

import { describe, expect, it } from "vitest";
import { rig, oneLineDiff, type Rig } from "./helpers/world.js";
import { resolveConfig } from "../src/config/settings.js";
import { createTransport, type TransportDeps } from "../src/transport/transports.js";
import { BODY_READ_CAP } from "../src/transport/http.js";
import type { FetchLike } from "../src/transport/types.js";
import { lunaStream } from "./helpers/luna-stream.js";

const T = "thr_b";
const EXACT = "it('x', () => expect(total(l)).toBe(42));";
const LOOSE = "it('x', () => expect(total(l)).toBeGreaterThan(0));";
const API = { reviewEnabled: true, providerRequestsEnabled: true, route: "sonnet:anthropic-api", anthropicApiKey: "sk-ant-test", usdPerDay: 1, apiRequestsPerDay: 10, budgetTimeZone: "UTC" };
const SONNET_OK = () =>
  new Response(JSON.stringify({ model: "claude-sonnet-5-5", content: [{ type: "text", text: '{"findings":[],"resolved":[]}' }], stop_reason: "end_turn", usage: { input_tokens: 3000, output_tokens: 200 } }), { status: 200 });

function turn(r: Rig, thread = T, n = 0) {
  r.world.turnStart(thread);
  r.world.fileChange(thread, `/repo/tests/t${n}.test.ts`, oneLineDiff(1, EXACT, LOOSE));
  r.world.turnEnd(thread);
}

// ------------------------------------------------------------------ #1 cancellation before the POST

describe("A230 #1 a review cancelled before its POST costs nothing", () => {
  it("transports never call fetch on an aborted signal, including after the token or secret wait", async () => {
    const calls: string[] = [];
    const fetch: FetchLike = async (u) => (calls.push(u), SONNET_OK());
    const pre = new AbortController();
    pre.abort("settings-changed");
    const d: TransportDeps = { fetch, loopbackBaseUrl: () => "http://x", poolerToken: async () => "t", secret: async () => "k" };
    for (const route of ["sonnet:anthropic-api", "sonnet:pool", "luna:openai-api", "luna:pool"]) {
      const res = await createTransport(resolveConfig({ route }).config, d).send({ body: "{}", cards: [] }, pre.signal);
      expect([route, res.outcome, res.dispatched]).toEqual([route, "pre-upstream", "none"]);
    }
    // aborted while the Pooler token was being read
    const mid = new AbortController();
    const slowToken: TransportDeps = { ...d, poolerToken: async () => (mid.abort("paused"), "t") };
    const res = await createTransport(resolveConfig({ route: "sonnet:pool" }).config, slowToken).send({ body: "{}", cards: [] }, mid.signal);
    expect([res.outcome, res.dispatched]).toEqual(["pre-upstream", "none"]);
    expect(calls).toEqual([]);
  });

  const races: Array<[string, (r: Rig, watchId: string) => void | Promise<void>]> = [
    ["pause", (r, id) => r.advisor.pause(id, "test")],
    ["disable", (r, id) => r.advisor.setEnabled(id, false, "test")],
    ["unwatch", (r, id) => r.advisor.unwatch(id, "test")],
    ["settings change", (r) => void r.advisor.applySettings({ ...API, usdPerDay: 2 })],
    ["unload", (r) => r.advisor.dispose()],
  ];
  for (const [name, act] of races) {
    it(`${name} during the pre-send reads: no ledger charge, no request counted, no fetch`, async () => {
      const calls: string[] = [];
      const r = await rig({ ...API }, { fetch: async (u) => (calls.push(u), SONNET_OK()) });
      r.world.addThread(T);
      await r.advisor.watch(T, "test");
      await r.tick();
      turn(r);
      r.clock.advance(5 * 60_000);
      await r.advisor.tick(new AbortController().signal); // the dispatch starts in the background
      const w = r.store.getWatchByThread(T)!;
      await act(r, w.id);
      await r.advisor.idle();
      expect(calls).toEqual([]);
      for (const l of r.store.listLedger()) expect([l.state, l.posted]).toEqual(["released", false]);
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(r.clock.now()));
      expect(r.store.dayTotals(day, "usd")).toEqual({ usd: 0, tokens: 0, requests: 0 });
    });
  }
});

// ------------------------------------------------------------------ #2 Jev body cap

describe("A230 #2 Jev honors the whole encoded body cap", () => {
  it("bodyCapKiB 24 with a full window: smaller windows with named gaps, never repeated config errors", async () => {
    const bodies: number[] = [];
    const fetch: FetchLike = async (_u, init) => {
      const b = JSON.parse(String(init.body));
      bodies.push(Buffer.byteLength(String(init.body)));
      const answers = Object.fromEntries(Object.keys(b.questions).map((k) => [k, { type: "noul", noul: 0.1 }]));
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 0 } }), { status: 200 });
    };
    const r = await rig({ reviewEnabled: true, providerRequestsEnabled: true, route: "jev:typesafe", typesafeApiKey: "ts", usdPerDay: 1, apiRequestsPerDay: 50, budgetTimeZone: "UTC", bodyCapKiB: 24, minGapMinutes: 0, refillMinutes: 1, bucketSize: 10 }, { fetch });
    r.world.addThread(T);
    await r.advisor.watch(T, "t");
    await r.tick();
    r.world.turnStart(T);
    const pad = "x".repeat(1100);
    for (let i = 0; i < 16; i++) r.world.fileChange(T, `/repo/tests/t${i}.test.ts`, oneLineDiff(1, `it('a${i}', () => expect(f()).toBe(${i})); // ${pad}`, `it('a${i}', () => expect(f()).toBeTruthy()); // ${pad}`));
    r.world.turnEnd(T);
    for (let k = 0; k < 6; k++) {
      r.clock.advance(5 * 60_000);
      await r.tick();
    }
    const w = r.store.getWatchByThread(T)!;
    expect(r.store.listReviews(w.id, 50).filter((x) => x.state === "config-error")).toEqual([]);
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b).toBeLessThanOrEqual(24 * 1024);
    expect(r.store.backlog(w.id)).toBe(0);
  });
});

// ------------------------------------------------------------------ #3 pooled Luna stream

describe("A230 #3 pooled Luna stream (realistic offline Responses stream)", () => {
  const PKT = { body: "{}", cards: [] };
  const pooled = (stream: string): TransportDeps => ({
    fetch: async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "x-account-pool-dispatch": "sent" } }),
    loopbackBaseUrl: () => "http://x",
    poolerToken: async () => "t",
    secret: async () => undefined,
  });

  it("a stream within maxOutputTokens but over 256 KiB of framing still completes", async () => {
    const s = lunaStream({ visibleTokens: 1500, reasoningTokens: 400 });
    expect(s.usage.output_tokens).toBeLessThanOrEqual(2000); // the default maxOutputTokens
    expect(Buffer.byteLength(s.text)).toBeGreaterThan(BODY_READ_CAP);
    const cfg = resolveConfig({ route: "luna:pool" }).config;
    const res = await createTransport(cfg, pooled(s.text)).send(PKT, new AbortController().signal);
    expect(res).toMatchObject({ outcome: "completed", dispatched: "sent", usage: { output: s.usage.output_tokens } });
    expect((res.output as any).findings).toHaveLength(s.findings);
  });

  it("the streamed total is bounded by its own setting: over it is cut, not read on", async () => {
    const s = lunaStream({ visibleTokens: 1500, reasoningTokens: 400 });
    const cfg = resolveConfig({ route: "luna:pool", lunaStreamCapKiB: 256 }).config;
    const res = await createTransport(cfg, pooled(s.text)).send(PKT, new AbortController().signal);
    expect(res).toMatchObject({ outcome: "cut", dispatched: "sent" });
    expect(res.error).toMatch(/stream/u);
  });
});

// ------------------------------------------------------------------ #4 time-zone changes

describe("A230 #4 a budget time-zone change never grants a fresh day", () => {
  it("changing to a zone already on the next date carries today's charges until that zone's next day", async () => {
    let posts = 0;
    const r = await rig({ ...API, apiRequestsPerDay: 1, minGapMinutes: 0 }, { fetch: async () => (posts++, SONNET_OK()) });
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    r.clock.advance(23 * 60 * 60_000); // 09:00 UTC on 6 Oct
    turn(r, T, 0);
    r.clock.advance(60_000);
    await r.tick();
    expect(posts).toBe(1); // spent at 09:01 UTC, before Kiritimati's 7 Oct began (10:00 UTC)
    r.clock.advance(90 * 60_000);
    // 10:31 UTC on 6 Oct is already 7 Oct in Kiritimati (UTC+14): a fresh calendar day there.
    await r.harness.behavior.setSettings({ budgetTimeZone: "Pacific/Kiritimati" });
    await r.reload({ fetch: async () => (posts++, SONNET_OK()) });
    expect(r.advisor.resolved.config.budgets.timeZone).toBe("Pacific/Kiritimati");
    turn(r, T, 1);
    for (let i = 0; i < 3; i++) {
      r.clock.advance(10 * 60_000);
      await r.tick();
    }
    expect(posts).toBe(1);
    // Kiritimati's 8 Oct begins at 10:00 UTC on 7 Oct: the carry ends and a new period starts.
    r.clock.advance(24 * 60 * 60_000);
    await r.tick();
    expect(posts).toBe(2);
  });
});

// ------------------------------------------------------------------ #5 invalid stored values

describe("A230 #5 invalid stored settings fail reviews closed, visibly", () => {
  it("an unknown route or a malformed number is a review error, never a silent default", () => {
    for (const raw of [{ route: "gpt-9" }, { bodyCapKiB: "lots" }, { usdPerDay: -1 }, { reviewEnabled: "yes" }, { concurrency: 99 }]) {
      const res = resolveConfig(raw);
      expect(res.reviewErrors.join(" ")).toMatch(new RegExp(Object.keys(raw)[0]!, "u"));
    }
    expect(resolveConfig({}).reviewErrors).toEqual([]); // missing fields keep their documented defaults
    expect(resolveConfig({ usdPerDay: null }).reviewErrors).toEqual([]); // an unset optional cap is not invalid
  });

  it("the runtime holds dispatch and shows the error", async () => {
    const r = await rig({ reviewEnabled: true });
    r.advisor.applySettings({ reviewEnabled: true, route: "gpt-9" });
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    expect(r.advisor.dispatchHold(w)).toMatch(/settings: .*route/u);
  });
});
