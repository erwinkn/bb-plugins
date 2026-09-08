import assert from "node:assert/strict";
import { test } from "node:test";
import { WatchRegistry } from "./watch-registry.js";

test("a root is shared by its clients and released by the last one", () => {
  const registry = new WatchRegistry();
  const a = registry.register("h1", "/w", "c1", 100);
  const b = registry.register("h1", "/w", "c2", 100);
  assert.equal(a, b);
  assert.equal(a.watching, false);
  registry.markWatching("h1", ["/w"]);
  assert.equal(a.watching, true);
  assert.deepEqual(registry.rootsOn("h1"), ["/w"]);
  assert.equal(registry.unregister("h1", "/w", "c1"), false);
  assert.equal(registry.unregister("h1", "/w", "missing"), false);
  assert.equal(registry.unregister("h1", "/w", "c2"), true);
  assert.equal(registry.get("h1", "/w"), undefined);
});

test("keys hide the host and path, and hosts are kept apart", () => {
  const registry = new WatchRegistry();
  const one = registry.register("h1", "/w", "c", 100);
  const two = registry.register("h2", "/w", "c", 100);
  assert.notEqual(one.key, two.key);
  assert.doesNotMatch(one.key, /h1|\/w/);
  assert.deepEqual(registry.rootsOn("h2"), ["/w"]);
  registry.markWatching("h1", []);
  assert.equal(one.watching, false);
  assert.equal(two.watching, false);
});

test("prune drops expired clients and names the hosts whose roots went away", () => {
  const registry = new WatchRegistry();
  registry.register("h1", "/a", "c1", 50);
  registry.register("h1", "/a", "c2", 150);
  registry.register("h1", "/b", "c3", 50);
  registry.register("h2", "/c", "c4", 150);
  assert.deepEqual(registry.prune(100), ["h1"]);
  assert.deepEqual(registry.rootsOn("h1"), ["/a"]);
  assert.equal(registry.get("h1", "/a")?.clients.size, 1);
  assert.deepEqual(registry.prune(100), []);
  assert.deepEqual(registry.prune(200).sort(), ["h1", "h2"]);
  assert.deepEqual(registry.rootsOn("h1"), []);
});
