import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProviderBridgeEntry } from "@get-bb/plugin-sdk/provider-bridge";
import { devinIdentity, fileCatalogStore, FRESH_MS, MAX_AGE_MS, MAX_CATALOG_BYTES, UNKNOWN_IDENTITY_TTL_MS } from "./model-cache";
import { withDevinModels } from "./model-bridge";
import { buildDevinModels } from "./models";

const variant = (model_uid: string, label: string) => ({ model_uid, label, max_context_tokens: 200000 });
const fixture = { families: [{ family_uid: "gpt", family_label: "GPT", variants: [variant("opaque-a", "GPT Low Thinking"), variant("opaque-b", "GPT Medium Thinking"), variant("opaque-c", "GPT Low Thinking Fast")] }] };
const groupId = buildDevinModels(fixture).models[1].id;
const launch = { command: "fake-devin", args: ["acp"], env: {}, displayName: "Devin" };
const tick = () => new Promise(r => setImmediate(r));
async function settle(check: () => boolean, ms = 2000) { const end = Date.now() + ms; while (!check() && Date.now() < end) await tick(); }
const cachePath = (dir: string) => join(dir, "model-catalog.json");
type Fetch = (command: string, signal?: AbortSignal) => Promise<unknown>;
const T0 = 1_000_000_000_000;

// One bridge per process in production; here separate instances stand in for
// separate bridge processes that share the plugin data directory.
function bridge(dir: string, fetch: Fetch, opts: { identity?: string | (() => string | undefined); now?: () => number } = {}) {
  const forwarded: any[] = [], output: any[] = [];
  const acp: ProviderBridgeEntry = { experimental_apiVersion: 1, handleLine: line => { forwarded.push(JSON.parse(line)); } };
  const identity = typeof opts.identity === "function" ? opts.identity : () => (opts.identity as string | undefined) ?? "id-1";
  const entry = withDevinModels(acp, fetch, line => output.push(JSON.parse(line)), { identity: async () => identity(), now: opts.now ?? (() => T0) });
  entry.start!({ pluginId: "erwin-devin", dataDir: dir, tempDir: dir });
  const select = (id: number, reasoningLevel?: string, serviceTier?: string, model = groupId) => entry.handleLine(JSON.stringify({
    jsonrpc: "2.0", id, method: "thread/start", params: { threadId: `t${id}`, options: { model, reasoningLevel, serviceTier, permissionMode: "full", providerOptions: { acpLaunchSpec: launch } } },
  }));
  return { entry, forwarded, output, select };
}
function counting(raw: unknown = fixture) {
  const calls: AbortSignal[] = [];
  const fetch: Fetch = async (_command, signal) => { calls.push(signal!); await tick(); return raw; };
  return { fetch, calls };
}
function tempDir(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "bb-devin-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a second bridge instance reuses the persisted catalog and starts without a lookup", async (t) => {
  const dir = tempDir(t);
  const first = counting();
  const a = bridge(dir, first.fetch);
  a.select(1, "low", "fast");
  await settle(() => a.forwarded.length === 1);
  assert.equal(first.calls.length, 1);
  assert.equal(a.forwarded[0].params.options.model, "opaque-c");
  const persisted = JSON.parse(readFileSync(cachePath(dir), "utf8"));
  assert.equal(persisted.identity, "id-1"); assert.equal(persisted.fetchedAt, T0); assert.deepEqual(persisted.catalog, fixture);

  const second = counting();
  const b = bridge(dir, second.fetch);
  const started = performance.now();
  b.select(2, "medium");
  await settle(() => b.forwarded.length === 1);
  const elapsed = performance.now() - started;
  assert.equal(second.calls.length, 0, "cached selection must not run the catalog command");
  assert.equal(b.forwarded[0].params.options.model, "opaque-b");
  assert.equal(b.forwarded[0].params.options.reasoningLevel, undefined);
  assert.ok(elapsed < 200, `cached startup took ${elapsed.toFixed(1)}ms`);
  assert.equal(b.output.length, 0);
});

test("a stale catalog is used at once and refreshed in the background; expired data blocks", async (t) => {
  const dir = tempDir(t);
  const stale = { ...fixture, families: [{ ...fixture.families[0], variants: fixture.families[0].variants.slice(0, 2) }] };
  await fileCatalogStore(dir).write({ version: 1, identity: "id-1", fetchedAt: T0 - FRESH_MS - 1, catalog: stale });
  let release!: () => void;
  const calls: string[] = [];
  const slow: Fetch = (command) => { calls.push(command); return new Promise(r => { release = () => r(fixture); }); };
  const b = bridge(dir, slow);
  b.select(1, "medium");
  await settle(() => b.forwarded.length === 1);
  assert.equal(b.forwarded[0].params.options.model, "opaque-b", "served from the stale cache before the refresh finished");
  assert.equal(calls.length, 1, "one background refresh started");
  release();
  await settle(() => { try { return JSON.parse(readFileSync(cachePath(dir), "utf8")).catalog.families[0].variants.length === 3; } catch { return false; } });
  assert.equal(JSON.parse(readFileSync(cachePath(dir), "utf8")).fetchedAt, T0);
  // Now a fresh cache: a Fast selection resolves without any lookup.
  b.select(2, "low", "fast");
  await settle(() => b.forwarded.length === 2);
  assert.equal(calls.length, 1); assert.equal(b.forwarded[1].params.options.model, "opaque-c");

  await fileCatalogStore(dir).write({ version: 1, identity: "id-1", fetchedAt: T0 - MAX_AGE_MS, catalog: fixture });
  const c = bridge(dir, slow);
  c.select(3, "medium");
  await settle(() => calls.length === 2);
  await tick(); await tick();
  assert.equal(c.forwarded.length, 0, "expired data must wait for the live catalog");
  release();
  await settle(() => c.forwarded.length === 1);
  assert.equal(c.forwarded[0].params.options.model, "opaque-b");
});

test("a selection missing from the cache blocks for a live lookup and never substitutes", async (t) => {
  const dir = tempDir(t);
  const old = { families: [{ family_uid: "gpt", family_label: "GPT", variants: [variant("opaque-a", "GPT Low Thinking"), variant("opaque-b", "GPT Medium Thinking")] }] };
  await fileCatalogStore(dir).write({ version: 1, identity: "id-1", fetchedAt: T0, catalog: old });
  const live = counting();
  const b = bridge(dir, live.fetch);
  b.select(1, "low", "fast");
  await settle(() => b.forwarded.length === 1);
  assert.equal(live.calls.length, 1, "unknown Fast cell forces a live lookup");
  assert.equal(b.forwarded[0].params.options.model, "opaque-c");
  b.select(2, "max");
  await settle(() => b.output.length === 1);
  assert.equal(live.calls.length, 2);
  assert.match(b.output[0].error.message, /does not offer/);
  assert.equal(b.forwarded.length, 1, "no substitute model was forwarded");
  b.select(3, undefined, undefined, "devin-family:gone");
  await settle(() => b.output.length === 2);
  assert.match(b.output[1].error.message, /no longer available/);
});

test("an identity change, corrupt data, and the wrong schema are misses that get overwritten", async (t) => {
  const dir = tempDir(t);
  await fileCatalogStore(dir).write({ version: 1, identity: "id-1", fetchedAt: T0, catalog: fixture });
  const other = counting();
  const b = bridge(dir, other.fetch, { identity: "id-2" });
  b.select(1, "medium");
  await settle(() => b.forwarded.length === 1);
  assert.equal(other.calls.length, 1);
  assert.equal(JSON.parse(readFileSync(cachePath(dir), "utf8")).identity, "id-2");

  for (const bad of ["{not json", JSON.stringify({ version: 2, identity: "id-1", fetchedAt: T0, catalog: fixture }), JSON.stringify({ version: 1, identity: "id-1", fetchedAt: T0, catalog: { families: [] } })]) {
    writeFileSync(cachePath(dir), bad);
    const live = counting();
    const c = bridge(dir, live.fetch);
    c.select(1, "medium");
    await settle(() => c.forwarded.length === 1);
    assert.equal(live.calls.length, 1);
    assert.equal(c.forwarded[0].params.options.model, "opaque-b");
    assert.deepEqual(JSON.parse(readFileSync(cachePath(dir), "utf8")).catalog, fixture);
  }
});

test("a catalog at the probe size limit still round-trips through the cache", async (t) => {
  const dir = tempDir(t);
  const store = fileCatalogStore(dir);
  const bare = JSON.stringify({ ...fixture, padding: "" });
  const raw = { ...fixture, padding: "x".repeat(MAX_CATALOG_BYTES - bare.length) };
  assert.equal(JSON.stringify(raw).length, MAX_CATALOG_BYTES, "raw catalog exactly at the probe limit");
  await store.write({ version: 1, identity: "id-1", fetchedAt: T0, catalog: raw });
  assert.ok(readFileSync(cachePath(dir)).length > MAX_CATALOG_BYTES, "the envelope is larger than the raw catalog");
  const entry = await store.read();
  assert.equal(entry?.identity, "id-1");
  assert.deepEqual(buildDevinModels(entry!.catalog).models.map(m => m.id), buildDevinModels(fixture).models.map(m => m.id));
  writeFileSync(cachePath(dir), "x".repeat(MAX_CATALOG_BYTES + 64 * 1024 + 1));
  assert.equal(await store.read(), undefined, "anything beyond the documented overhead is a miss");
});

test("concurrent writers leave one complete file and no temp files", async (t) => {
  const dir = tempDir(t);
  const store = fileCatalogStore(dir);
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.write({ version: 1, identity: `id-${i}`, fetchedAt: T0 + i, catalog: fixture })));
  const entry = await store.read();
  assert.ok(entry && /^id-\d+$/.test(entry.identity));
  assert.deepEqual(readdirSync(dir), ["model-catalog.json"]);
  const missing = fileCatalogStore(join(dir, "nested", "deeper"));
  await missing.write({ version: 1, identity: "x", fetchedAt: T0, catalog: fixture });
  assert.equal((await missing.read())?.identity, "x");
  assert.equal(await fileCatalogStore(join(dir, "absent")).read(), undefined);
});

test("a failed background refresh keeps the old catalog; close aborts it; cancel returns no delayed start", async (t) => {
  const dir = tempDir(t);
  await fileCatalogStore(dir).write({ version: 1, identity: "id-1", fetchedAt: T0 - FRESH_MS, catalog: fixture });
  const failing = { fetch: (async (_c, signal) => { failing.signals.push(signal!); throw new Error("boom"); }) as Fetch, signals: [] as AbortSignal[] };
  const b = bridge(dir, failing.fetch);
  b.select(1, "medium");
  await settle(() => b.forwarded.length === 1);
  await settle(() => failing.signals.length === 1);
  await tick(); await tick();
  assert.deepEqual(b.output, [], "background failure is not reported to the runtime");
  assert.equal(JSON.parse(readFileSync(cachePath(dir), "utf8")).fetchedAt, T0 - FRESH_MS);

  const hanging = { fetch: ((_c, signal) => { hanging.signals.push(signal!); return new Promise(() => {}); }) as Fetch, signals: [] as AbortSignal[] };
  const c = bridge(dir, hanging.fetch);
  c.select(2, "medium");
  await settle(() => hanging.signals.length === 1);
  c.entry.onClose?.();
  assert.equal(hanging.signals[0].aborted, true, "close aborts the background refresh");

  let release!: () => void;
  const d = bridge(dir, () => new Promise(r => { release = () => r(fixture); }), { identity: "id-9" });
  d.select(3, "medium");
  d.entry.handleLine('{"jsonrpc":"2.0","id":4,"method":"thread/stop","params":{"threadId":"t3"}}');
  await settle(() => release !== undefined);
  release();
  await settle(() => d.output.length === 1);
  assert.match(d.output[0].error.message, /cancelled/);
  assert.deepEqual(d.forwarded.map(m => m.method), ["thread/stop"], "no delayed thread/start after stop");
  assert.equal(JSON.parse(readFileSync(cachePath(dir), "utf8")).identity, "id-9", "the completed lookup still refreshes the shared cache");
});

test("without an identity the catalog is kept in this process only, for a short time", async (t) => {
  const dir = tempDir(t);
  let clock = T0;
  const live = counting();
  const b = bridge(dir, live.fetch, { identity: () => undefined, now: () => clock });
  b.select(1, "medium"); await settle(() => b.forwarded.length === 1);
  b.select(2, "low", "fast"); await settle(() => b.forwarded.length === 2);
  assert.equal(live.calls.length, 1, "a second selection in the same process reuses the catalog");
  assert.equal(existsSync(cachePath(dir)), false, "nothing is persisted without an identity");
  clock += UNKNOWN_IDENTITY_TTL_MS;
  b.select(3, "medium"); await settle(() => b.forwarded.length === 3);
  assert.equal(live.calls.length, 2, "the process-local copy expires");
  const other = counting();
  const c = bridge(dir, other.fetch, { identity: () => undefined, now: () => clock });
  c.select(4, "medium"); await settle(() => c.forwarded.length === 1);
  assert.equal(other.calls.length, 1, "another process does not see the local copy");
});

test("a sign-in change during a lookup does not join the older lookup", async (t) => {
  const dir = tempDir(t);
  const releases: Array<() => void> = [];
  const slow: Fetch = () => new Promise(r => { releases.push(() => r(fixture)); });
  let current = "id-1";
  const b = bridge(dir, slow, { identity: () => current });
  b.select(1, "medium");
  await settle(() => releases.length === 1);
  current = "id-2";
  b.select(2, "medium");
  await settle(() => releases.length === 2);
  assert.equal(releases.length, 2, "the new identity starts its own lookup");
  releases[1]!(); await settle(() => b.forwarded.length === 1);
  assert.equal(JSON.parse(readFileSync(cachePath(dir), "utf8")).identity, "id-2");
  releases[0]!(); await settle(() => b.forwarded.length === 2);
  assert.equal(JSON.parse(readFileSync(cachePath(dir), "utf8")).identity, "id-1", "the older lookup still writes the identity it started with");
  // Same command and identity still share one lookup.
  const d = bridge(dir, slow, { identity: () => "id-9" });
  d.select(3, "medium"); d.select(4, "low");
  await settle(() => releases.length === 3); await tick(); await tick();
  assert.equal(releases.length, 3);
  releases[2]!(); await settle(() => d.forwarded.length === 2);
});

test("identity follows the executable and the local sign-in state without reading credentials", async (t) => {
  const home = tempDir(t);
  const env = { XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config") };
  mkdirSync(join(env.XDG_DATA_HOME, "devin"), { recursive: true });
  mkdirSync(join(env.XDG_CONFIG_HOME, "devin"), { recursive: true });
  const binary = join(home, "devin-a");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const credentials = join(env.XDG_DATA_HOME, "devin", "credentials.toml");
  const config = join(env.XDG_CONFIG_HOME, "devin", "config.json");
  assert.equal(await devinIdentity(binary, env), undefined, "no sign-in file means no persistent cache");
  writeFileSync(credentials, "api_key = \"secret-one\"\n");
  utimesSync(credentials, new Date(T0), new Date(T0));
  const signedIn = await devinIdentity(binary, env);
  assert.match(signedIn!, /^[a-f0-9]{64}$/);
  assert.equal(await devinIdentity(binary, env), signedIn, "identity is stable across calls");
  // Same size and same timestamps: only the content differs.
  writeFileSync(credentials, "api_key = \"secret-two\"\n");
  utimesSync(credentials, new Date(T0), new Date(T0));
  const reLogin = await devinIdentity(binary, env);
  assert.notEqual(reLogin, signedIn, "a new sign-in changes the identity");
  assert.doesNotMatch(reLogin!, /secret/);
  writeFileSync(config, JSON.stringify({ version: 1, devin: { org_id: "org-b" } }));
  const otherOrg = await devinIdentity(binary, env);
  assert.notEqual(otherOrg, reLogin, "another organization changes the identity");
  writeFileSync(config, "{broken");
  assert.equal(await devinIdentity(binary, env), reLogin, "an unreadable config counts as no organization");
  assert.equal(await devinIdentity(binary, { ...env, WINDSURF_API_KEY: "x" }), undefined, "environment credentials disable the cache");
  assert.equal(await devinIdentity(join(home, "missing-devin"), env), undefined, "a missing executable has no identity");
  const other = join(home, "devin-b");
  writeFileSync(other, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.notEqual(await devinIdentity(other, env), reLogin, "a different executable is a different identity");
});
