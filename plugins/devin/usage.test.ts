import assert from "node:assert/strict";
import test from "node:test";
import { providerUsageResultSchema, experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import { decodeUsageResponse, encodeUsageFixture, encodeCachedUsageFixture } from "./usage-codec";
import { getDevinUsage, normalizeUsage } from "./usage";
import { mkdtemp, mkdir, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFreshUsageCache, probeDevinUsage } from "./usage-probe";
import { withDevinUsage } from "./usage-bridge";

const sample = {
  userStatus: { email: "test@example.test", planStatus: {
    planInfo: { planName: "Pro" }, dailyQuotaRemainingPercent: 75, weeklyQuotaRemainingPercent: 40,
    dailyQuotaResetAtUnix: 1800000000, weeklyQuotaResetAtUnix: 1800100000,
  } },
};
test("protobuf quota data maps to BB windows; zero remaining is exhausted", () => {
  const usage = normalizeUsage(decodeUsageResponse(encodeUsageFixture(sample)));
  assert.equal(usage.status, "ok");
  if (usage.status !== "ok") return;
  assert.deepEqual(usage.windows.map(w => [w.label, w.usedPercent]), [["Daily limit", 25], ["Weekly limit", 60]]);
  assert.equal(usage.windows[0]?.resetsAt, new Date(1800000000 * 1000).toISOString());
  const exhausted = normalizeUsage(decodeUsageResponse(encodeUsageFixture({userStatus:{planStatus:{dailyQuotaResetAtUnix:1800000000}}})));
  assert.equal(exhausted.status, "ok");
  if (exhausted.status === "ok") assert.deepEqual(exhausted.windows.map(w => w.usedPercent), [100]);
});

test("hidden or absent quotas produce no fake limit; optional ACU fields retain presence", () => {
  for (const raw of [{ userStatus: {} }, { userStatus: { planStatus: { planInfo: { hideDailyQuota: true, hideWeeklyQuota: true }, dailyQuotaResetAtUnix: 1800000000, weeklyQuotaResetAtUnix: 1800100000 } } }]) {
    const u = normalizeUsage(decodeUsageResponse(encodeUsageFixture(raw)));
    assert.equal(u.status, "ok");if (u.status === "ok") assert.deepEqual(u.windows, []);
  }
  const u = normalizeUsage(decodeUsageResponse(encodeUsageFixture({ userStatus: { planStatus: { acuConsumed: 25, acuLimit: 100 } } })));
  assert.equal(u.status, "ok");if (u.status === "ok") assert.equal(u.windows[0]?.usedPercent, 25);
  const bad = normalizeUsage({ userStatus: { planStatus: { weeklyQuotaRemainingPercent: 101 } } });
  assert.equal(bad.status, "error");
});

test("fresh cache reader rejects ambiguous, malformed and oversized files", async () => {
  const cache = await mkdtemp(join(tmpdir(), "devin-cache-test-"));
  try {
    assert.equal(await readFreshUsageCache(cache), undefined);
    const dir = join(cache, "devin", "cli");await mkdir(dir, { recursive: true });
    const file = join(dir, "user_status.abcd.bin");
    const envelope = { version: 1, identity_digest: "abcd", fetched_at_secs: Date.now()/1000,
      payload: Buffer.from(encodeCachedUsageFixture(sample.userStatus)).toString("base64") };
    await writeFile(file, JSON.stringify(envelope));
    const usage = normalizeUsage(await readFreshUsageCache(cache));
    assert.equal(usage.status, "ok");if (usage.status === "ok") assert.equal(usage.windows[1]?.usedPercent, 60);
    await writeFile(join(dir, "user_status.1234.bin"), JSON.stringify(envelope));
    await assert.rejects(() => readFreshUsageCache(cache), /ambiguous/);
    await rm(join(dir, "user_status.1234.bin"));
    await writeFile(file, JSON.stringify({ ...envelope, version: 2 }));
    await assert.rejects(() => readFreshUsageCache(cache));
    // Non-canonical or empty Base64 must not decode to an empty "successful" status.
    for (const payload of ["A", "", "AAA", "QQ=", "QUJD===", "Q-Jd"]) {
      await writeFile(file, JSON.stringify({ ...envelope, payload }));
      await assert.rejects(() => readFreshUsageCache(cache), `payload ${JSON.stringify(payload)}`);
    }
    await writeFile(file, "x".repeat(2 * 1024 * 1024 + 1));
    await assert.rejects(() => readFreshUsageCache(cache), /too large/);
  } finally { await rm(cache, { recursive: true, force: true }); }
});

test("sessionless probe initializes a CLI and reads its private cache", async () => {
  const command = fileURLToPath(new URL("./test-usage-agent.mjs", import.meta.url));
  const usage = normalizeUsage(await probeDevinUsage(command));
  assert.equal(usage.status, "ok");
  if (usage.status === "ok") assert.equal(usage.windows[0]?.usedPercent, 25);
});

test("probe child does not inherit bridge runtime variables", async () => {
  const command = fileURLToPath(new URL("./test-usage-agent.mjs", import.meta.url));
  process.env.ELECTRON_RUN_AS_NODE = "1";
  try { assert.equal(normalizeUsage(await probeDevinUsage(command)).status, "ok", "the scripted peer exits when it sees the variable"); }
  finally { delete process.env.ELECTRON_RUN_AS_NODE; }
});

test("a command that cannot be spawned leaves no temporary directory", async () => {
  const before = (await readdir(tmpdir())).filter(n => n.startsWith("bb-devin-usage-"));
  await assert.rejects(() => probeDevinUsage("bad\u0000command"));
  const after = (await readdir(tmpdir())).filter(n => n.startsWith("bb-devin-usage-"));
  assert.deepEqual(after, before);
});

test("usage states handle missing CLI and probe failures without exposing errors", async () => {
  const notInstalled = await getDevinUsage("devin", { executable: async () => null, probe: async () => { throw new Error("must not run"); } });
  assert.equal(notInstalled.supported && notInstalled.usage.status, "not_installed");
  const failed = await getDevinUsage("devin", { executable: async () => "/devin", probe: async () => { throw new Error("private-value"); } });
  providerUsageResultSchema.parse(failed);
  assert.equal(failed.supported && failed.usage.status, "error");assert.ok(!JSON.stringify(failed).includes("private-value"));
  const ok = await getDevinUsage("custom-devin", { executable: async c => `/resolved/${c}`, probe: async c => { assert.equal(c, "/resolved/custom-devin", "the probe runs the resolved executable");return sample; } });
  providerUsageResultSchema.parse(ok);assert.equal(ok.supported && ok.usage.status, "ok");
});

test("bridge delegates session traffic and lifecycle; usage routing validates input", async () => {
  const forwarded: string[] = [], outputs: any[] = [];
  let started = false, closed = false, probes = 0;
  const bridge = withDevinUsage(experimental_defineProviderBridge({
    handleLine: line => forwarded.push(line), start: () => { started = true; }, onClose: () => { closed = true; },
  }), async command => { probes++; assert.equal(command, "/custom/devin"); await new Promise(r => setImmediate(r)); return { supported: true, usage: { status: "unauthenticated" } }; }, line => outputs.push(JSON.parse(line)));
  bridge.start?.({ pluginId: "test", dataDir: "/tmp", tempDir: "/tmp" });
  bridge.handleLine('{"method":"turn/start"}');bridge.handleLine('bad-json');
  const params = { providerId: "acp-devin", providerOptions: { acpLaunchSpec: { displayName: "Devin", command: "/custom/devin", args: ["acp"], env: {} } } };
  bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "provider/usage", params }));
  bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "provider/usage", params }));
  bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "provider/usage", params: {} }));
  bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "provider/usage", params: { ...params, providerId: "other" } }));
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  bridge.onClose?.();
  assert.ok(started && closed);assert.equal(forwarded.length, 2);
  assert.equal(outputs.find(x => x.id === 1)?.result.usage.status, "unauthenticated");
  assert.equal(outputs.find(x => x.id === 4)?.result.usage.status, "unauthenticated");
  assert.equal(probes, 1, "overlapping refreshes share one probe");
  assert.equal(outputs.find(x => x.id === 2)?.error.code, -32602);
  assert.deepEqual(outputs.find(x => x.id === 3)?.result, { supported: false });
});
