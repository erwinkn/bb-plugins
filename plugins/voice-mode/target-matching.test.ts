import test from "node:test";
import assert from "node:assert/strict";
import { queryTokens, rank, resolveName, scoreName, tokenSimilarity, tokenize } from "./target-matching.ts";

test("tokenize splits on any separator and keeps short words", () => {
  assert.deepEqual(tokenize("BB-plugins"), ["bb", "plugins"]);
  assert.deepEqual(tokenize("BB_plugins"), ["bb", "plugins"]);
  assert.deepEqual(tokenize("Éditeur mobile"), ["editeur", "mobile"]);
  assert.deepEqual(queryTokens("the latest BB plugin project"), ["bb", "plugin"]);
  assert.deepEqual(queryTokens("the latest threads"), []);
});

test("token similarity accepts stems and small typos", () => {
  assert.equal(tokenSimilarity("plans", "plans"), 1);
  assert.equal(tokenSimilarity("plan", "plans"), 0.9);
  assert.equal(tokenSimilarity("planned", "plans"), 0.85);
  assert.equal(tokenSimilarity("plugin", "plugins"), 0.9);
  assert.equal(tokenSimilarity("voice", "vioce"), 0.8);
  assert.equal(tokenSimilarity("bb", "plugins"), 0);
  assert.equal(tokenSimilarity("mobile", "editor"), 0);
});

test("scores reflect the share of spoken words present in the name", () => {
  assert.equal(scoreName(queryTokens("BB plugin project"), "bb-plugins"), 0.95);
  assert.equal(scoreName(queryTokens("BB underscore plugins"), "bb-plugins"), 0.67);
  assert.equal(scoreName(queryTokens("planned plugin child thread for new plans feature"), "Overhaul well plans plugin"), 0.71);
  assert.equal(scoreName(queryTokens("planned plugin child thread for new plans feature"), "Make voice mode more reliable"), 0);
  assert.equal(scoreName([], "anything"), 1);
});

test("rank orders by score then recency and applies the threshold", () => {
  const items = [{ name: "Mobile API fixes", at: 3 }, { name: "Editor mobile fixes", at: 2 }, { name: "Build Fix", at: 1 }];
  const tokens = queryTokens("the latest editor mobile thread");
  assert.deepEqual(rank(items, tokens, i => i.name, i => i.at).map(r => [r.item.name, r.match]), [["Editor mobile fixes", 1], ["Mobile API fixes", 0.5]]);
  assert.deepEqual(rank(items, [], i => i.name, i => i.at).map(r => r.item.name), ["Mobile API fixes", "Editor mobile fixes", "Build Fix"]);
  assert.deepEqual(rank(items, ["editor", "api"], i => i.name, i => i.at, { threshold: 0.25 }).map(r => r.item.name), ["Mobile API fixes", "Editor mobile fixes"]);
  assert.deepEqual(rank(items, ["editor", "api"], i => i.name, i => i.at, { threshold: 0.6 }), []);
  assert.deepEqual(rank(items, ["nothing"], i => i.name, i => i.at, { threshold: 0 }).map(r => r.match), [0, 0, 0]);
});

test("resolveName picks the unique best configured name", () => {
  const profiles = ["investigate", "plan", "implement", "review"];
  assert.equal(resolveName("Investigate", profiles, p => p), "investigate");
  assert.equal(resolveName("investigation", profiles, p => p), "investigate");
  assert.equal(resolveName("planning", profiles, p => p), "plan");
  assert.equal(resolveName("default", profiles, p => p), null);
  assert.equal(resolveName("", profiles, p => p), null);
});
