// The plugin through the SDK fake host: settings validation and persistence,
// defaults, secrets, RPC actions with honest meanings, preview, CLI, service
// loop and reload.

import { describe, expect, it } from "vitest";
import { rig, oneLineDiff } from "./helpers/world.js";

const T = "thr_p";
const EXACT = "it('computes totals', () => expect(total(l)).toBe(42));";
const LOOSE = "it('computes totals', () => expect(total(l)).toBeGreaterThan(0));";

async function withFinding(settings: Record<string, unknown> = { reviewEnabled: true }) {
  const r = await rig(settings);
  r.world.addThread(T);
  await r.harness.behavior.callRpc("watchAdd", { threadId: T });
  await r.tick();
  r.world.turnStart(T);
  r.world.fileChange(T, "/repo/tests/totals.test.ts", oneLineDiff(1, EXACT, LOOSE));
  r.world.turnEnd(T);
  r.clock.advance(5 * 60_000);
  await r.tick();
  return r;
}

describe("settings", () => {
  it("defaults: observation on, reviews and provider requests off, fake route, no caps", async () => {
    const r = await rig({});
    const o: any = await r.harness.behavior.callRpc("overview");
    expect(o.activation).toEqual({ observation: true, review: false, providerRequests: false, route: "fake", routeLabel: expect.any(String), billing: "none" });
    expect(o.today.usd.cap).toBeNull();
    expect(o.deferred.map((d: any) => d.id)).toEqual(["initiative-intake", "coordinator-wake", "decision-capture"]);
  });

  it("field validation runs on every save path; bad values are refused", async () => {
    const r = await rig({});
    for (const bad of [{ bodyCapKiB: 100 }, { concurrency: 0 }, { budgetTimeZone: "Mars/Olympus_Mons" }, { customInstructions: '"'.repeat(3000) }, { jevThreshold: 0 }, { usdPerDay: -1 }]) {
      await expect(r.harness.behavior.setSettings(bad)).rejects.toThrow();
    }
    await r.harness.behavior.setSettings({ bodyCapKiB: 32, budgetTimeZone: "Europe/Paris" });
    expect(r.advisor.resolved.config.bodyCap).toBe(32 * 1024);
    expect(r.advisor.resolved.config.budgets.timeZone).toBe("Europe/Paris");
  });

  it("unsupported combinations are errors that stop review dispatch, never aliased", async () => {
    const r = await rig({ reviewEnabled: true, route: "sonnet:anthropic-api", sonnetThinking: "between_tools", sonnetEffort: "max" });
    const s: any = await r.harness.behavior.callRpc("settingsView");
    expect(s.errors.review).toEqual([
      'Sonnet 5.5 accepts thinking "between_tools" only at effort high or below, not "max".',
      "Route sonnet:anthropic-api needs the secret setting anthropicApiKey.",
      "Route sonnet:anthropic-api bills USD: set both the daily USD cap and the daily API request cap.",
    ]);
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    expect(r.advisor.dispatchHold(r.store.getWatchByThread(T)!)).toMatch(/^settings: Sonnet 5.5 accepts/u);
  });

  it("secrets stay server-side: views show only whether they are set; the log names keys only", async () => {
    const r = await rig({});
    await r.harness.behavior.setSettings({ anthropicApiKey: "sk-ant-SECRET-123" });
    const s: any = await r.harness.behavior.callRpc("settingsView");
    const all = JSON.stringify([s, await r.harness.behavior.callRpc("overview")]);
    expect(all).not.toContain("SECRET-123");
    expect(s.secrets).toEqual({ anthropicApiKey: true, openaiApiKey: false, typesafeApiKey: false });
    expect(s.settingsLog[0].summary).toBe("anthropicApiKey: set");
  });

  it("a review-affecting change bumps the settings revision and is logged; display-only changes do not bump it", async () => {
    const r = await rig({});
    const rev0 = r.advisor.settingsRev;
    await r.harness.behavior.setSettings({ severityThreshold: "note" });
    expect(r.advisor.settingsRev).toBe(rev0);
    await r.harness.behavior.setSettings({ route: "luna:openai-api" });
    expect(r.advisor.settingsRev).toBe(rev0 + 1);
    const log: any = await r.harness.behavior.callRpc("settingsView");
    expect(log.settingsLog.slice(0, 2).map((x: any) => x.summary)).toEqual(['route: "luna:openai-api"', 'severityThreshold: "note"']);
  });
});

describe("Account Pooler advisor route indicator", () => {
  const view = (claude: boolean, codex: boolean, error: string | null = null) => ({ routes: { claude, codex }, maxUtilization: null, effectiveMaxUtilization: 0.98, error });

  it("says whether the Pooler lets the selected route through and how to turn it on, read-only", async () => {
    const r = await rig({ route: "sonnet:pool" });
    r.world.poolerAdvisor = view(false, true);
    let s: any = await r.harness.behavior.callRpc("settingsView");
    expect(s.pooler).toMatchObject({ status: "read", provider: "claude", permitted: false, routes: { claude: false, codex: true } });
    expect(s.pooler.detail).toBe(
      "Blocked: the Pooler's Claude advisor route is off. Turn it on with `bb pool-local advisor set claude on` or in the Account Pooler's Advisor routes settings.",
    );
    await r.harness.behavior.setSettings({ route: "luna:pool" });
    s = await r.harness.behavior.callRpc("settingsView");
    expect(s.pooler).toMatchObject({ provider: "codex", permitted: true, detail: "Allowed: the Pooler's Codex advisor route is on (accounts up to 98% utilization)." });
    r.world.poolerAdvisor = view(true, true, "Stored advisor-config is invalid, so advisor routes are off: (record): bad");
    s = await r.harness.behavior.callRpc("settingsView");
    expect(s.pooler).toMatchObject({ permitted: false, detail: "Blocked: Stored advisor-config is invalid, so advisor routes are off: (record): bad" });
  });

  it("degrades when the Pooler is absent, and is informational for routes that do not use it", async () => {
    const r = await rig({ route: "sonnet:pool" });
    let s: any = await r.harness.behavior.callRpc("settingsView");
    expect(s.pooler).toMatchObject({ status: "unavailable", routes: null, provider: "claude", permitted: false });
    expect(s.pooler.detail).toBe("The Account Pooler is not installed, disabled or not responding (no advisor.get). Route sonnet:pool cannot send until it answers.");
    r.world.poolerAdvisor = { unexpected: true };
    s = await r.harness.behavior.callRpc("settingsView");
    expect(s.pooler.detail).toBe("The Account Pooler returned an unexpected advisor.get response. Route sonnet:pool cannot send until it answers.");
    await r.harness.behavior.setSettings({ route: "fake" });
    r.world.poolerAdvisor = view(true, false);
    s = await r.harness.behavior.callRpc("settingsView");
    expect(s.pooler).toMatchObject({ provider: null, permitted: null, detail: "Not used by route fake. Pooler advisor routes: claude on, codex off." });
  });
});

describe("panel actions keep their honest meaning", () => {
  it("acknowledge marks a finding seen, not signed off; mute and dismiss are issue states; clear only hides acknowledged rows", async () => {
    const r = await withFinding();
    const w = r.store.getWatchByThread(T)!;
    const d: any = await r.harness.behavior.callRpc("watchDetail", { watchId: w.id });
    expect(d.findings).toHaveLength(1);
    const f = d.findings[0];
    expect(f.badges).toContain("fake reviewer: not a judgment");
    await r.harness.behavior.callRpc("findingAcknowledge", { occurrenceId: f.id });
    expect(r.store.issueState(w.id, f.category, f.locator)).toBe("open"); // acknowledging changes nothing about the issue
    const cleared: any = await r.harness.behavior.callRpc("findingsClearAcknowledged", { watchId: w.id });
    expect(cleared.cleared).toBe(1);
    expect(r.store.getOccurrence(f.id)).not.toBeNull(); // still stored
    await r.harness.behavior.callRpc("issueSetState", { watchId: w.id, category: f.category, locator: f.locator, state: "muted" });
    expect(r.store.issueState(w.id, f.category, f.locator)).toBe("muted");
    const actions = r.store.listActions(10).map((a) => [a.action, a.caller]);
    expect(actions).toContainEqual(["acknowledge", "unverified"]);
    expect(actions).toContainEqual(["issue-muted", "unverified"]);
  });

  it("preview sends the selected route's packet to the fake reviewer: no request, no ledger, no frontier move", async () => {
    const calls: string[] = [];
    const r = await rig({ route: "sonnet:anthropic-api" }, { fetch: async (u) => (calls.push(u), new Response("{}")) });
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    await r.tick();
    r.world.turnStart(T);
    r.world.fileChange(T, "/repo/tests/totals.test.ts", oneLineDiff(1, EXACT, LOOSE));
    r.world.turnEnd(T);
    await r.tick();
    const w = r.store.getWatchByThread(T)!;
    const backlog = r.store.backlog(w.id);
    const res: any = await r.harness.behavior.callRpc("previewReview", { watchId: w.id });
    expect(res.state).toBe("current");
    expect(calls).toEqual([]);
    expect(r.store.listLedger()).toEqual([]);
    expect(r.store.backlog(w.id)).toBe(backlog);
    const rv = r.store.getReview(res.reviewId)!;
    expect(rv).toMatchObject({ preview: true, route: "preview:sonnet:anthropic-api" });
    expect(r.store.listOccurrences(w.id)[0]!.preview).toBe(true);
  });

  it("recordsGet is the read-only intake surface for later stages", async () => {
    const r = await withFinding();
    const w = r.store.getWatchByThread(T)!;
    const id = r.store.listOccurrences(w.id)[0]!.id;
    const out: any = await r.harness.behavior.callRpc("recordsGet", { occurrenceIds: [id, "nope"] });
    expect([out.records.map((x: any) => x.id), out.missing]).toEqual([[id], ["nope"]]);
  });

  it("evidence pages newest first and opens from the card while it exists", async () => {
    const r = await withFinding();
    const w = r.store.getWatchByThread(T)!;
    const ev: any = await r.harness.behavior.callRpc("watchEvidence", { watchId: w.id, limit: 2 });
    expect(ev.cards.map((c: any) => c.kind)).toEqual(["turn", "edit"]);
    const occ = r.store.listOccurrences(w.id)[0]!;
    const opened: any = await r.harness.behavior.callRpc("findingOpen", { occurrenceId: occ.id });
    expect([opened.source, opened.complete]).toEqual(["evidence", true]);
  });
});

describe("CLI, service and reload", () => {
  it("bb advisor status / watch / findings, bounded", async () => {
    const r = await rig({ reviewEnabled: true });
    r.world.addThread(T);
    const watch = await r.harness.behavior.runCli(["watch", T]);
    expect(watch.exitCode).toBe(0);
    const status = await r.harness.behavior.runCli(["status"]);
    expect(status.stdout).toContain("reviews: on · provider requests: off");
    expect(status.stdout).toContain(T);
    const bad = await r.harness.behavior.runCli(["frobnicate"]);
    expect(bad.exitCode).toBe(2);
  });

  it("the background service runs ticks and ends on abort", async () => {
    const r = await rig({});
    r.world.addThread(T);
    await r.advisor.watch(T, "test");
    const svc = r.harness.behavior.runService("advisor");
    await new Promise((res) => setTimeout(res, 50));
    svc.controller.abort();
    await svc.done;
    expect(r.store.getWatchByThread(T)!.seeded).toBe(true);
  });

  it("watches, evidence, findings and the settings revision survive a reload", async () => {
    const r = await withFinding();
    const rev = r.advisor.settingsRev;
    const w = r.store.getWatchByThread(T)!;
    await r.reload();
    expect(r.store.getWatchByThread(T)!.id).toBe(w.id);
    expect(r.store.listOccurrences(w.id)).toHaveLength(1);
    expect(r.advisor.settingsRev).toBe(rev);
    const o: any = await r.harness.behavior.callRpc("overview");
    expect(o.watches[0].threadId).toBe(T);
  });
});
