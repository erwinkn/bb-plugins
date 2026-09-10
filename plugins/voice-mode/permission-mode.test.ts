import test from "node:test";
import assert from "node:assert/strict";
import { permissionModeSchema, resolvePermissionMode } from "./permission-mode.ts";

test("inherited profiles defer to BB and retain explicit legacy profile choices", () => {
  assert.equal(resolvePermissionMode("inherit"), undefined);
  assert.equal(resolvePermissionMode("accept-edits"), "accept-edits");
  assert.equal(resolvePermissionMode("accept-edits", "auto"), "auto");
});

test("only BB launch modes are accepted as explicit overrides", () => {
  assert.deepEqual(permissionModeSchema.options, ["accept-edits", "auto", "full"]);
  assert.equal(permissionModeSchema.safeParse("surprise").success, false);
});
