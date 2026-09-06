import assert from "node:assert/strict";
import test from "node:test";
import { parseBranding, planLabels } from "./branding";
import mapping from "./providers.json";

test("optional values fail safely without limiting IDs to ACP", () => {
  const config = parseBranding({ amp: { label: "Amp", icon: mapping["acp-devin"].icon },
    "my-agent": {}, "acp-other": { icon: "https://example.com/track.png", label: " " },
    wrong: null, "bad/id": {}, broken: { label: 42, icon: false } });
  assert.equal(config.entries.amp?.label, "Amp");
  assert.ok(config.entries.amp?.icon);
  assert.deepEqual(config.entries["my-agent"], {});
  assert.deepEqual(config.entries["acp-other"], {});
  assert.deepEqual(config.entries.broken, {});
  assert.equal(config.entries["bad/id"], undefined);
  assert.equal(config.entries.wrong, undefined);
  assert.equal(config.warnings.length, 6);
  assert.equal(parseBranding(null).warnings.length, 1);
  assert.equal(parseBranding({ p: { icon: "data:image/svg+xml;base64,AAAA" } }).entries.p?.icon, undefined);
  assert.equal(parseBranding({ p: { label: "x".repeat(81) } }).entries.p?.label, undefined);
  assert.equal(parseBranding({ p: { icon: "data:image/png;base64," + "A".repeat(131072) } }).entries.p?.icon, undefined);
});

test("ACP label plan preserves launch/auth fields and unrelated entries", () => {
  const original = [{ id: "devin", displayName: "Devin", command: "/bin/devin", args: ["acp"], env: { API_KEY: "test-placeholder" }, customField: true },
    { id: "other", displayName: "Other", command: "other" }];
  const { entries } = parseBranding({ "acp-devin": { label: "Devin CLI" }, amp: { label: "New Amp" } });
  const plan = planLabels(JSON.stringify(original), entries);
  assert.deepEqual(JSON.parse(plan.next), [{ ...original[0], displayName: "Devin CLI" }, original[1]]);
  assert.deepEqual(plan.changes, [{ providerId: "acp-devin", before: "Devin", after: "Devin CLI" }]);
  assert.ok(!JSON.stringify(plan.changes).includes("test-placeholder"));
  assert.deepEqual(planLabels(plan.next, entries).changes, []);
  assert.throws(() => planLabels("invalid", entries));
  assert.throws(() => planLabels("[null]", entries));
});
