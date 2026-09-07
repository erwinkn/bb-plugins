import assert from "node:assert/strict";
import { test } from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import type { ExperimentalHostWatchListener, ExperimentalHostWatchOptions } from "@get-bb/plugin-sdk";
import entry from "./host.js";
import { MAX_CHANGED_PATHS } from "./lib/watch-contract.js";

/** A watcher the test drives by hand: it records starts and stops and hands out listeners. */
function fakeWatcher() {
  const active = new Map<string, ExperimentalHostWatchListener>();
  const log: string[] = [];
  const watch = (options: ExperimentalHostWatchOptions, listener: ExperimentalHostWatchListener) => {
    if (options.rootPath.endsWith("/broken")) throw new Error("no watcher here");
    log.push(`start ${options.rootPath}`);
    active.set(options.rootPath, listener);
    return {
      dispose: async () => {
        log.push(`stop ${options.rootPath}`);
        active.delete(options.rootPath);
      },
    };
  };
  return { active, log, watch };
}

test("syncWatches starts, keeps and stops watches to match the requested roots", async (t) => {
  const watcher = fakeWatcher();
  const harness = experimental_createHostEntryHarness(entry, { experimental_watch: watcher.watch });
  t.after(() => harness.experimental_dispose());
  const first = await harness.experimental_call("syncWatches", { roots: ["/a", "/b"] });
  assert.deepEqual(first, { watching: ["/a", "/b"], failed: [] });
  const second = await harness.experimental_call("syncWatches", { roots: ["/b", "/c", "/c/broken"] });
  assert.deepEqual(second.watching, ["/b", "/c"]);
  assert.deepEqual(second.failed, [{ rootPath: "/c/broken", message: "no watcher here" }]);
  assert.deepEqual(watcher.log, ["start /a", "start /b", "stop /a", "start /c"]);
  assert.ok(watcher.active.has("/b") && watcher.active.has("/c"));
  await harness.experimental_call("syncWatches", { roots: [] });
  assert.equal(watcher.active.size, 0);
});

test("changes, overflow, lost events and watcher failures reach the server as signals", async (t) => {
  const watcher = fakeWatcher();
  const harness = experimental_createHostEntryHarness(entry, { experimental_watch: watcher.watch });
  t.after(() => harness.experimental_dispose());
  await harness.experimental_call("syncWatches", { roots: ["/w"] });
  const listener = watcher.active.get("/w")!;
  await listener({ kind: "changed", changes: [{ path: "/w/a.ts", type: "update" }, { path: "/w/b.ts", type: "create" }, { path: "/elsewhere/c.ts", type: "delete" }, { path: "/w", type: "update" }] });
  await listener({ kind: "changed", changes: Array.from({ length: MAX_CHANGED_PATHS + 1 }, (_, i) => ({ path: `/w/${i}`, type: "update" as const })) });
  await listener({ kind: "rescan-required" });
  await listener({ kind: "watch-error", message: "overflow" });
  assert.deepEqual(harness.experimental_getSignals().map((s) => [s.payload.kind, s.payload.paths.length]), [
    ["changed", 2], ["rescan", 0], ["rescan", 0], ["rescan", 0],
  ]);
  assert.deepEqual(harness.experimental_getSignals()[0]!.payload.paths, [
    { path: "a.ts", type: "update" }, { path: "b.ts", type: "create" },
  ]);
  // The failed watch was dropped, so the next sync starts it again.
  assert.equal(watcher.active.has("/w"), false);
  const again = await harness.experimental_call("syncWatches", { roots: ["/w"] });
  assert.deepEqual(again.watching, ["/w"]);
  assert.equal(watcher.active.has("/w"), true);
});

test("a batch from a stopped watch is ignored and dispose stops everything", async () => {
  const watcher = fakeWatcher();
  const harness = experimental_createHostEntryHarness(entry, { experimental_watch: watcher.watch });
  await harness.experimental_call("syncWatches", { roots: ["/x", "/y"] });
  const stale = watcher.active.get("/x")!;
  await harness.experimental_call("syncWatches", { roots: ["/y"] });
  await stale({ kind: "changed", changes: [{ path: "/x/late", type: "update" }] });
  assert.deepEqual(harness.experimental_getSignals(), []);
  await harness.experimental_dispose();
  assert.equal(watcher.active.size, 0);
});
