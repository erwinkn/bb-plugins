import assert from "node:assert/strict";
import { test } from "node:test";
import { hostOfflineMessage, isHostOfflineMessage } from "./host-offline.js";

test("the daemon's raw failure and the translated message both read as host-offline", () => {
  assert.ok(isHostOfflineMessage("HTTP 502: Host is not connected"));
  assert.ok(isHostOfflineMessage("rpc tree failed: Host is not connected"));
  assert.ok(isHostOfflineMessage("Host Erwin's MacBook Pro is not connected"));
  assert.ok(isHostOfflineMessage("This workspace's host is not connected"));
  assert.ok(!isHostOfflineMessage("ENOENT: no such file or directory"));
  assert.ok(!isHostOfflineMessage("This workspace's host is not available"));
});

test("the offline message names the host when the server knows it", () => {
  assert.equal(hostOfflineMessage("Erwin's MacBook Pro"), "Host Erwin's MacBook Pro is not connected");
  assert.equal(hostOfflineMessage(null), "This workspace's host is not connected");
});
