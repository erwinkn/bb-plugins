import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDevinModels, DEFAULT_MODEL_ID, FAMILY_PREFIX } from "./models";
import { withDevinModels } from "./model-bridge";
import type { ProviderBridgeEntry } from "@get-bb/plugin-sdk/provider-bridge";
const variant = (model_uid: string, label: string, max_context_tokens = 200000) => ({ model_uid, label, max_context_tokens });
const family = (family_uid: string, family_label: string, variants: ReturnType<typeof variant>[]) => ({ family_uid, family_label, variants });
const fixture = { families: [family("gpt", "GPT", [variant("opaque-a", "GPT Low Thinking"), variant("opaque-b", "GPT Medium Thinking"), variant("opaque-c", "GPT Low Thinking Fast"), variant("opaque-d", "GPT Medium Thinking Fast")]) ] };
function group(catalog: ReturnType<typeof buildDevinModels>, name = "GPT") { return catalog.models.find(m => m.displayName === name && m.id.startsWith(FAMILY_PREFIX))!; }

test("group by native family, resolve opaque IDs and retain saved variants", () => {
  const c = buildDevinModels(fixture), m = group(c);
  assert.equal(c.models.length, 2);
  assert.equal(c.models[0].id, DEFAULT_MODEL_ID);
  assert.equal(c.models[0].id, "acp-default", "the SDK ACP bridge sends no model selection only for this ID");
  assert.equal(c.resolve(DEFAULT_MODEL_ID), DEFAULT_MODEL_ID);
  assert.deepEqual(m.supportedReasoningEfforts.map(e => e.reasoningEffort), ["low", "medium"]);
  assert.equal(c.resolve(m.id, "low", "fast"), "opaque-c");
  assert.equal(c.resolve(m.id), "opaque-b");
  assert.equal(c.resolve("opaque-a", "medium", "fast"), "opaque-a");
  assert.equal(c.selectedOnlyModels.length, 4);
  assert.throws(() => c.resolve(m.id, "max", "fast"), /does not offer/);
});
test("no fast fallback; separate context, unknown effort, and binary thinking", () => {
  const c = buildDevinModels({ families: [family("claude", "Claude", [variant("off", "Claude"), variant("on", "Claude Thinking"), variant("off1m", "Claude 1M", 1000000), variant("on1m", "Claude Thinking 1M", 1000000)]), family("gemini", "Gemini", [variant("min", "Gemini Minimal"), variant("lo", "Gemini Low"), variant("hi", "Gemini High")])] });
  const m = group(c, "Claude");
  assert.deepEqual(m.supportedReasoningEfforts.map(e => e.reasoningEffort), ["none", "medium"]);
  assert.equal(c.resolve(m.id, "none"), "off");
  assert.equal(c.resolve(group(c, "Claude 1M").id, "medium"), "on1m");
  // Fast and 1M suffixes join the 1M group in either order.
  const order = buildDevinModels({ families: [family("claude", "Claude", [variant("off1m", "Claude 1M", 1000000), variant("on1m", "Claude Thinking 1M", 1000000), variant("on1mfast", "Claude Thinking 1M Fast", 1000000), variant("off1mfast", "Claude Fast 1M", 1000000)])] });
  assert.equal(order.resolve(group(order, "Claude 1M").id, "medium", "fast"), "on1mfast");
  assert.equal(order.resolve(group(order, "Claude 1M").id, "none", "fast"), "off1mfast");
  assert.equal(order.models.length, 2);
  assert.throws(() => c.resolve(m.id, "medium", "fast"), /does not offer/);
  assert(c.models.some(m => m.id === "min"));
});
test("join separate Fast family; keep ambiguous duplicate cells and unknown labels visible", () => {
  const c = buildDevinModels({ families: [family("swe", "SWE", [variant("s", "SWE")]), family("swe-fast", "SWE Fast", [variant("f", "SWE Fast")]), family("x", "X", [variant("x1", "X Low"), variant("x2", "X Low")])] });
  const m = group(c, "SWE");
  assert.equal(c.resolve(m.id, "medium", "fast"), "f");
  assert.equal(m.supportedReasoningEfforts.length, 0);
  assert(c.models.some(m => m.id === "x1"));
  assert(c.models.some(m => m.id === "x2"));
  assert.throws(() => buildDevinModels({ families: [family("x", "X", [variant("x", "X"), variant("x", "X")])] }), /Duplicate/);
  assert.throws(() => buildDevinModels({ families: [] }));
});
const launch = { command: "fake-devin", args: ["acp"], env: {}, displayName: "Devin" };
const tick = () => new Promise(r => setImmediate(r));
test("bridge lists models and maps start/resume/fork/turn without changing other options", async () => {
  const forwarded: string[] = [], output: any[] = [];
  const acp: ProviderBridgeEntry = { experimental_apiVersion: 1, handleLine: line => { forwarded.push(line); } };
  const c = buildDevinModels(fixture);
  const bridge = withDevinModels(acp, async () => c, line => output.push(JSON.parse(line)));
  bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "model/list", params: { providerOptions: { acpLaunchSpec: launch } } }));
  await tick(); assert.equal(output[0].result.models.length, 2);
  for (const method of ["thread/start", "thread/resume", "thread/fork", "turn/start"]) {
    bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method, params: { threadId: "t", options: { model: group(c).id, reasoningLevel: "low", serviceTier: "fast", permissionMode: "full", providerOptions: { acpLaunchSpec: launch } } } }));
    await tick();
    const options = JSON.parse(forwarded.at(-1)!).params.options;
    assert.equal(options.model, "opaque-c"); assert.equal(options.permissionMode, "full");
    assert.equal(options.reasoningLevel, undefined); assert.equal(options.serviceTier, undefined);
  }
  bridge.handleLine('{"jsonrpc":"2.0","id":3,"method":"provider/health"}');
  assert.equal(JSON.parse(forwarded.at(-1)!).method, "provider/health");
  bridge.handleLine('{"jsonrpc":"2.0","id":4,"method":"model/list","params":{}}');
  await tick(); assert.equal(output.at(-1).error.code, -32602);
});
test("stop during catalog load cannot start a delayed turn; close aborts the probe", async () => {
  let resolve!: (c: ReturnType<typeof buildDevinModels>) => void;
  let signal: AbortSignal | undefined;
  const forwarded: string[] = [], output: any[] = [];
  const c = buildDevinModels(fixture);
  const bridge = withDevinModels({ experimental_apiVersion: 1, handleLine: line => { forwarded.push(line); } }, (_command, s) => { signal = s; return new Promise(r => { resolve = r; }); }, line => output.push(JSON.parse(line)));
  bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "turn/start", params: { threadId: "t", options: { model: group(c).id, providerOptions: { acpLaunchSpec: launch } } } }));
  bridge.handleLine('{"jsonrpc":"2.0","id":2,"method":"thread/stop","params":{"threadId":"t"}}');
  resolve(c); await tick();
  assert.equal(forwarded.length, 1); assert.match(output[0].error.message, /cancelled/);
  bridge.onClose?.(); assert.equal(signal?.aborted, true);
});
