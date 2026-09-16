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
