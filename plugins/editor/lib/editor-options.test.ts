import assert from "node:assert/strict";
import test from "node:test";
import { AUTO_SAVE_DELAY_MS, prefsFrom } from "./editor-options";

test("auto save is on by default with a short delay", () => {
  assert.equal(prefsFrom(null).autoSave, "afterDelay");
  assert.equal(prefsFrom({}).autoSave, "afterDelay");
  assert.equal(prefsFrom({ autoSave: "later" }).autoSave, "afterDelay");
  assert.ok(AUTO_SAVE_DELAY_MS >= 200 && AUTO_SAVE_DELAY_MS <= 600, `delay ${AUTO_SAVE_DELAY_MS}ms`);
});

test("a stored choice wins over the default", () => {
  assert.equal(prefsFrom({ autoSave: "off" }).autoSave, "off");
  assert.equal(prefsFrom({ autoSave: "onBlur" }).autoSave, "onBlur");
  assert.equal(prefsFrom({ autoSave: "afterDelay" }).autoSave, "afterDelay");
});

test("the measured limits are the defaults and stored values win", () => {
  const defaults = prefsFrom(null).limits;
  assert.equal(defaults.interactive.bytes, 8 * 1024 * 1024);
  assert.equal(defaults.highlight.bytes, 1024 * 1024);
  assert.equal(defaults.wrapMaxLineLength, 50_000);
  const raised = prefsFrom({ highlightMaxKB: 4096, editMaxLineLength: 8_000_000 }).limits;
  assert.equal(raised.highlight.bytes, 4 * 1024 * 1024);
  assert.equal(raised.interactive.maxLineLength, 8_000_000);
  assert.equal(raised.interactive.lines, defaults.interactive.lines);
  // Invalid and negative values fall back to the measured defaults.
  const bad = prefsFrom({ highlightMaxKB: "big", editMaxLines: -5 }).limits;
  assert.equal(bad.highlight.bytes, defaults.highlight.bytes);
  assert.equal(bad.interactive.lines, defaults.interactive.lines);
});
