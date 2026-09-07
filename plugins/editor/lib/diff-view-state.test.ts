import assert from "node:assert/strict";
import test from "node:test";
import type { DiffEntry } from "./diff-contract";
import {
  canCompare,
  diffSessionSync,
  changeLabel,
  comparisonBranch,
  describeTarget,
  effectiveLayout,
  isCompact,
  needsBranch,
  neighbourPath,
  parseDiffParams,
  parseTarget,
  parseTargetKey,
  sameTarget,
  selectionAfterRefresh,
  summarize,
  targetKey,
  unavailableReason,
  viewPrefsFrom,
  withBranch,
  DEFAULT_VIEW_PREFS,
  SPLIT_MIN_WIDTH_PX,
} from "./diff-view-state";

const SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

function entry(path: string, overrides: Partial<DiffEntry> = {}): DiffEntry {
  return {
    path,
    previousPath: null,
    changeKind: "modified",
    origin: "tracked",
    binary: false,
    loadMode: "auto",
    additions: 1,
    deletions: 1,
    ...overrides,
  };
}

test("parseTarget accepts each comparison and refuses anything else", () => {
  assert.deepEqual(parseTarget({ type: "uncommitted" }), { type: "uncommitted" });
  assert.deepEqual(parseTarget({ type: "all" }), { type: "all" });
  assert.deepEqual(parseTarget({ type: "branch_committed", mergeBaseBranch: "main" }), {
    type: "branch_committed",
    mergeBaseBranch: "main",
  });
  assert.deepEqual(parseTarget({ type: "commit", sha: "a1b2c3d" }), { type: "commit", sha: "a1b2c3d" });
  for (const bad of [null, 42, [], {}, { type: "staged" }, { type: "commit" }, { type: "commit", sha: "zzz" }]) {
    assert.equal(parseTarget(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test("parseTarget refuses a branch name that could be read as an option or break a line", () => {
  assert.equal(parseTarget({ type: "all", mergeBaseBranch: "--upload-pack=evil" }), null);
  assert.equal(parseTarget({ type: "all", mergeBaseBranch: "main\nrm -rf" }), null);
  // An empty branch means "use the workspace's own base branch".
  assert.deepEqual(parseTarget({ type: "all", mergeBaseBranch: "" }), { type: "all" });
});

test("a target survives a round trip through its storage key", () => {
  for (const target of [
    { type: "uncommitted" },
    { type: "all" },
    { type: "all", mergeBaseBranch: "release/1.0" },
    { type: "branch_committed", mergeBaseBranch: "main" },
    { type: "commit", sha: SHA },
  ] as const) {
    assert.deepEqual(parseTargetKey(targetKey(target)), target);
  }
  assert.equal(parseTargetKey("commit:nothex"), null);
  assert.equal(parseTargetKey("nonsense"), null);
});

test("parseDiffParams takes only what it recognises", () => {
  assert.deepEqual(parseDiffParams({ target: { type: "commit", sha: "abcdef1" }, path: "src/a.ts" }), {
    target: { type: "commit", sha: "abcdef1" },
    path: "src/a.ts",
  });
  assert.deepEqual(parseDiffParams({ target: "uncommitted" }), { target: { type: "uncommitted" }, path: null });
  assert.deepEqual(parseDiffParams({ path: "" }), { target: null, path: null });
  assert.deepEqual(parseDiffParams("nope"), { target: null, path: null });
});

test("the wording names the branch a comparison uses, or says there is none", () => {
  assert.match(describeTarget({ type: "all" }, "main").detail, /compared with main/);
  assert.match(describeTarget({ type: "all", mergeBaseBranch: "dev" }, "main").detail, /compared with dev/);
  assert.match(describeTarget({ type: "all" }, null).detail, /the base branch/);
  assert.equal(describeTarget({ type: "commit", sha: SHA }, null).label, "a1b2c3d");
  assert.equal(comparisonBranch({ type: "uncommitted" }, "main"), null);
  assert.equal(needsBranch({ type: "branch_committed" }, null), true);
  assert.equal(needsBranch({ type: "uncommitted" }, null), false);
  assert.deepEqual(withBranch({ type: "all" }, " dev "), { type: "all", mergeBaseBranch: "dev" });
  assert.deepEqual(withBranch({ type: "uncommitted" }, "dev"), { type: "uncommitted" });
  assert.equal(sameTarget({ type: "all" }, { type: "all", mergeBaseBranch: "" }), true);
  assert.equal(sameTarget({ type: "all" }, { type: "all", mergeBaseBranch: "dev" }), false);
});

test("a refreshed list keeps the open file", () => {
  const files = [entry("a.ts"), entry("b.ts"), entry("c.ts")];
  assert.equal(selectionAfterRefresh(files, "b.ts", files), "b.ts");
});

test("a file that leaves the comparison hands over to its neighbour, not to the top", () => {
  const before = [entry("a.ts"), entry("b.ts"), entry("c.ts")];
  const after = [entry("a.ts"), entry("c.ts")];
  assert.equal(selectionAfterRefresh(after, "b.ts", before), "c.ts");
  // With nothing after it, the file before it takes over.
  assert.equal(selectionAfterRefresh([entry("a.ts")], "b.ts", before), "a.ts");
});

test("a list with no memory of the open file falls back to the first file that can be compared", () => {
  const files = [entry("big.bin", { binary: true }), entry("a.ts")];
  assert.equal(selectionAfterRefresh(files, "gone.ts", []), "a.ts");
  assert.equal(selectionAfterRefresh([], "a.ts", files), null);
  // Every file being uncomparable still leaves one to show the reason.
  assert.equal(selectionAfterRefresh([entry("big.bin", { binary: true })], null, []), "big.bin");
});

test("file navigation skips files that have no comparison and stops at the ends", () => {
  const files = [entry("a.ts"), entry("b.bin", { binary: true }), entry("c.ts")];
  assert.equal(neighbourPath(files, "a.ts", 1), "c.ts");
  assert.equal(neighbourPath(files, "c.ts", -1), "a.ts");
  assert.equal(neighbourPath(files, "c.ts", 1), null);
  assert.equal(neighbourPath(files, "a.ts", -1), null);
  // A file outside the list starts from the near end.
  assert.equal(neighbourPath(files, "b.bin", 1), "a.ts");
  assert.equal(neighbourPath([], null, 1), null);
});

test("the summary adds up the changed lines", () => {
  assert.deepEqual(summarize([entry("a.ts", { additions: 3, deletions: 0 }), entry("b.ts", { additions: 1, deletions: 4 })]), {
    files: 2,
    additions: 4,
    deletions: 4,
  });
  assert.deepEqual(summarize([]), { files: 0, additions: 0, deletions: 0 });
});

test("a file says what happened to it in plain words", () => {
  assert.equal(changeLabel(entry("a.ts", { changeKind: "added", origin: "untracked" })), "New file");
  assert.equal(changeLabel(entry("a.ts", { changeKind: "added" })), "Added");
  assert.equal(changeLabel(entry("a.ts", { changeKind: "deleted" })), "Deleted");
  assert.equal(changeLabel(entry("a.ts", { changeKind: "renamed" })), "Renamed");
  assert.equal(changeLabel(entry("a.ts", { changeKind: "type_changed" })), "Type changed");
  assert.equal(changeLabel(entry("a.ts")), "Changed");
});

test("a file with no line comparison says so before the server is asked", () => {
  assert.equal(unavailableReason(entry("a.ts")), null);
  assert.equal(canCompare(entry("a.ts")), true);
  assert.match(String(unavailableReason(entry("a.png", { binary: true }))), /not text/);
  assert.match(String(unavailableReason(entry("a.ts", { loadMode: "too_large" }))), /too large/);
  assert.match(String(unavailableReason(entry("a.ts", { changeKind: "type_changed" }))), /file type changed/);
  // A file the server loads on demand is still comparable.
  assert.equal(unavailableReason(entry("a.ts", { loadMode: "on_demand" })), null);
});

test("side by side gives way when the pane is too narrow for two columns", () => {
  assert.equal(effectiveLayout("split", SPLIT_MIN_WIDTH_PX), "split");
  assert.equal(effectiveLayout("split", SPLIT_MIN_WIDTH_PX - 1), "unified");
  assert.equal(effectiveLayout("unified", 2000), "unified");
  // An unmeasured pane must not flip the layout on the first frame.
  assert.equal(effectiveLayout("split", 0), "split");
  assert.equal(isCompact(0), false);
  assert.equal(isCompact(400), true);
});

test("stored view preferences fall back to the default value by value", () => {
  assert.deepEqual(viewPrefsFrom(null), DEFAULT_VIEW_PREFS);
  assert.deepEqual(viewPrefsFrom({ layout: "sideways", listWidth: "wide" }), DEFAULT_VIEW_PREFS);
  assert.deepEqual(viewPrefsFrom({ layout: "split", expandUnchanged: true, listOpen: false, listWidth: 260 }), {
    layout: "split",
    expandUnchanged: true,
    listOpen: false,
    listWidth: 260,
  });
  // A width below the minimum is raised, not accepted.
  assert.equal(viewPrefsFrom({ listWidth: 10 }).listWidth >= 140, true);
});

test("a save keeps the active file even when it leaves the change list", () => {
  const previous = [entry("a.ts"), entry("b.ts")];
  assert.equal(selectionAfterRefresh([entry("b.ts")], "a.ts", previous, "a.ts"), "a.ts");
  assert.equal(selectionAfterRefresh([], "a.ts", previous, "a.ts"), "a.ts");
  assert.equal(selectionAfterRefresh([entry("b.ts")], "a.ts", previous), "b.ts");
  assert.equal(selectionAfterRefresh([], "a.ts", previous), null);
  assert.equal(selectionAfterRefresh([entry("b.ts")], "b.ts", previous, "a.ts"), "b.ts");
});

test("saves acknowledge the new hash while external reads revalidate the diff", () => {
  const state = { load: { kind: "ready" as const }, hasEdits: false, sha256: "new", savedContentSource: "write" as const };
  assert.equal(diffSessionSync("old", state), "saved");
  assert.equal(diffSessionSync("new", state), "none");
  assert.equal(diffSessionSync("old", { ...state, savedContentSource: "read" }), "read");
  assert.equal(diffSessionSync("old", { ...state, hasEdits: true }), "none");
  assert.equal(diffSessionSync(null, state), "none");
});
