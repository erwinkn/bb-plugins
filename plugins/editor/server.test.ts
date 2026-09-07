import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost, experimental_scanPublicSdkOnly, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin, { findPluginRoot, rpcContract } from "./server";

const here = fileURLToPath(new URL(".", import.meta.url));

test("findPluginRoot locates the package from the source directory and from dist", () => {
  assert.equal(findPluginRoot(here), path.resolve(here));
  assert.equal(findPluginRoot(path.join(here, "dist")), path.resolve(here));
  assert.throws(() => findPluginRoot("/"), /could not locate/);
});

test("the RPC contract validates source shapes strictly", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "erwin-editor" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  await assert.rejects(() => harness.behavior.callRpc("read", { path: "a.ts", source: { kind: "nope" } }));
  await assert.rejects(() => harness.behavior.callRpc("read", { path: "", source: { kind: "workspace", threadId: null, environmentId: null, projectId: null } }));
  await assert.rejects(() => harness.behavior.callRpc("workspace", { threadId: "thr_x" }));
  await assert.rejects(() =>
    harness.behavior.callRpc("read", {
      path: "a.ts",
      source: { kind: "workspace", threadId: null, environmentId: null, projectId: null, extra: 1 },
    }),
  );
});

test("workspace without a thread or project asks for a project", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "erwin-editor" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  await assert.rejects(() => harness.behavior.callRpc("workspace", { threadId: null, projectId: null }), /Select a project/);
});

test("contract exposes the methods the frontend calls", () => {
  assert.deepEqual(Object.keys(rpcContract).sort(), ["applyTheme", "assets", "create", "diffList", "diffRead", "read", "remove", "rename", "setSetting", "theme", "tree", "workspace", "write"]);
});

test("read, write, and tree refuse paths that leave the workspace", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "erwin-editor" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const source = { kind: "workspace", threadId: null, environmentId: null, projectId: null };
  await assert.rejects(() => harness.behavior.callRpc("read", { path: "../secrets", source }), /cannot contain/);
  await assert.rejects(() => harness.behavior.callRpc("read", { path: "/etc/passwd", source }), /inside the workspace/);
  await assert.rejects(
    () => harness.behavior.callRpc("write", { path: "a/../../x", source, content: "", expectedSha256: null }),
    /cannot contain/,
  );
  await assert.rejects(() => harness.behavior.callRpc("tree", { source, subpath: "../.." }), /cannot contain/);
  // A thread id names a directory under thread storage; path-like ids are refused at the schema.
  const storage = { kind: "thread-storage", threadId: "../..", environmentId: null, projectId: null };
  await assert.rejects(() => harness.behavior.callRpc("read", { path: "bb.db", source: storage }));
  await assert.rejects(() => harness.behavior.callRpc("tree", { source: { ...storage, threadId: "/" } }));
});

test("create refuses parent traversal and setSetting refuses unknown keys", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "erwin-editor" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const source = { kind: "workspace", threadId: null, environmentId: null, projectId: null };
  await assert.rejects(() => harness.behavior.callRpc("create", { path: "../x", source, kind: "file" }), /cannot contain/);
  await assert.rejects(() => harness.behavior.callRpc("rename", { path: "a.ts", source, newPath: "/etc/passwd" }), /inside the workspace/);
  await assert.rejects(() => harness.behavior.callRpc("remove", { path: "..", source, kind: "directory" }), /cannot contain/);
  await assert.rejects(() => harness.behavior.callRpc("setSetting", { key: "fontSize", value: 40 }));
  await assert.rejects(() => harness.behavior.callRpc("setSetting", { key: "wordWrap", value: "yes" }));
});

test("plugin uses only public SDK imports and declared packages", () => {
  const scan = experimental_scanPublicSdkOnly(here, {
    allow: [
      /^react(-dom)?$/,
      /^sonner$/,
      /^clsx$/,
      /^tailwind-merge$/,
      /^@hugeicons\//,
      /^shiki\//,
      /^@shikijs\/(langs|themes)\//,
      /^@pierre\/theme\//,
      /^@pierre\/diffs(\/|$)/,
      /^esbuild$/,
      /^@\//,
    ],
  });
  assert.deepEqual(scan.privateDependencies, []);
  const dynamic = scan.violations.filter((violation) => violation.reason === "dynamic-specifier");
  // The lazily served editor bundle and the on-demand asset build are the only
  // computed import paths; anything else is a mistake.
  assert.deepEqual(
    dynamic.map((violation) => violation.file).sort(),
    ["lib/pierre-loader.ts", "server.ts"],
  );
  assert.deepEqual(scan.violations.filter((violation) => violation.reason !== "dynamic-specifier"), []);
});

type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
type DiffFiles = Extract<Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["diffFiles"]>>, { outcome: "available" }>;

const environment: Environment = {
  id: "env_test", hostId: "host_remote", projectId: "proj_test", path: "/workspace",
  branchName: "feature", baseBranch: "main", defaultBranch: "main", mergeBaseBranch: null,
  name: null, isGitRepo: true, isWorktree: true, managed: true, status: "ready",
  workspaceProvisionType: "managed-worktree", createdAt: 0, updatedAt: 0,
};
const modifiedEntry: DiffFiles["files"][number] = {
  path: "a.ts", previousPath: null, changeKind: "modified", origin: "tracked",
  binary: false, loadMode: "auto", additions: 1, deletions: 1,
};

type Status = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["status"]>>;

/** A workspace status with only the working-tree files that matter here. */
function statusWith(files: { path: string; status: "M" | "U" }[]): Status {
  return {
    outcome: "available",
    workspace: {
      branch: { currentBranch: "feature", defaultBranch: "main" },
      checkout: { kind: "branch", branchName: "feature", headSha: "abcdef0123456789" },
      mergeBase: null,
      workingTree: {
        files: files.map((file) => ({ ...file, insertions: null, deletions: null })),
        state: "dirty_uncommitted", hasUncommittedChanges: true, insertions: 0, deletions: 0, lineStatsComplete: true,
      },
    },
  };
}

async function diffHost(options: {
  entry?: Partial<typeof modifiedEntry>;
  liveContent?: string;
  newContent?: string;
  oldContent?: string;
  truncated?: boolean;
  files?: DiffFiles["files"];
  mergeBaseRef?: string | null;
  status?: () => Promise<Status>;
  diffFile?: (query: { path: string; side: "old" | "new" }) => Promise<{ content: string; contentEncoding: "utf8" | "base64"; path: string; sizeBytes: number }>;
} = {}) {
  const entry = { ...modifiedEntry, ...options.entry };
  const newContent = options.newContent ?? "new\n";
  const { bb, harness } = createFakePluginHost({
    pluginId: "erwin-editor",
    sdk: {
      threads: { get: async () => makeThreadResponse({ environmentId: environment.id, projectId: environment.projectId }) },
      environments: {
        get: async () => environment,
        status: options.status ?? (async () => statusWith([{ path: entry.path, status: "M" }])),
        diffFiles: async () => ({
          outcome: "available", files: options.files ?? [entry], mergeBaseRef: options.mergeBaseRef === undefined ? "abcdef0123456789" : options.mergeBaseRef,
          initialPatches: [{ path: entry.path, patch: "", truncated: options.truncated ?? false }],
          shortstat: "1 file changed", truncated: false,
        }),
        diffFile: options.diffFile ?? (async ({ path: filePath, side }) => ({
          content: side === "old" ? options.oldContent ?? "old\n" : newContent,
          contentEncoding: "utf8", path: filePath, sizeBytes: 4,
        })),
      },
      files: {
        read: async ({ path: filePath }) => ({
          path: filePath, content: options.liveContent ?? newContent, contentEncoding: "utf8",
          sha256: "live-hash", sizeBytes: 4, mimeType: "text/plain",
        }),
      },
    },
  });
  await plugin(bb);
  return { bb, harness };
}

test("diff writes use the workspace host and a live hash, not a snapshot hash", async (t) => {
  const { harness } = await diffHost();
  t.after(() => harness.lifecycle.dispose());
  const result = rpcContract.diffRead.output.parse(await harness.behavior.callRpc("diffRead", { threadId: "thr_test", target: { type: "uncommitted" }, path: "a.ts" }));
  assert.equal(result.kind, "text");
  assert.equal(result.kind, "text");
  assert.equal(result.editable, true);
  assert.equal(result.sha256, "live-hash");
  assert.equal(result.source.experimental_hostId, "host_remote");
  const calls = harness.inspection.sdk.callsTo("files.read");
  assert.deepEqual(calls[0]?.[0], { path: "/workspace/a.ts", rootPath: "/workspace", hostId: "host_remote" });
});

test("diff refuses editing when disk changed between snapshot and live read", async (t) => {
  const { harness } = await diffHost({ liveContent: "agent edit\n" });
  t.after(() => harness.lifecycle.dispose());
  const result = rpcContract.diffRead.output.parse(await harness.behavior.callRpc("diffRead", { threadId: "thr_test", target: { type: "uncommitted" }, path: "a.ts" }));
  assert.equal(result.kind, "text");
  assert.equal(result.editable, false);
  assert.equal(typeof result.reason, "string");
  assert.match(result.reason ?? "", /changed while loading/);
  assert.equal(result.newContent, "new\n");
});

test("historical comparisons never read a live file or expose a save hash", async (t) => {
  const { harness } = await diffHost();
  t.after(() => harness.lifecycle.dispose());
  const result = rpcContract.diffRead.output.parse(await harness.behavior.callRpc("diffRead", { threadId: "thr_test", target: { type: "commit", sha: "abcdef0" }, path: "a.ts" }));
  assert.equal(result.kind, "text");
  assert.equal(result.editable, false);
  assert.equal(result.sha256, null);
  assert.equal(harness.inspection.sdk.callsTo("files.read").length, 0);
  assert.equal(harness.inspection.sdk.callsTo("environments.status").length, 0);
});

test("branch_committed reads HEAD at the merge base and stays read-only", async (t) => {
  const { harness } = await diffHost();
  t.after(() => harness.lifecycle.dispose());
  const result = rpcContract.diffRead.output.parse(await harness.behavior.callRpc("diffRead", { threadId: "thr_test", target: { type: "branch_committed", mergeBaseBranch: "main" }, path: "a.ts" }));
  assert.equal(result.kind, "text");
  assert.equal(result.editable, false);
  assert.match(result.reason ?? "", /saved revision/);
  assert.equal(result.sha256, null);
  const calls = harness.inspection.sdk.callsTo("environments.diffFile").map((call) => call[0]);
  assert.deepEqual(calls, [
    { environmentId: "env_test", target: "branch_committed", mergeBaseRef: "abcdef0123456789", side: "old", path: "a.ts" },
    { environmentId: "env_test", target: "branch_committed", mergeBaseRef: "abcdef0123456789", side: "new", path: "a.ts" },
  ]);
  assert.equal(harness.inspection.sdk.callsTo("files.read").length, 0);
  assert.equal(harness.inspection.sdk.callsTo("environments.status").length, 0);
});

test("a branch comparison without a merge base explains itself instead of showing no changes", async (t) => {
  const { harness } = await diffHost({ files: [], mergeBaseRef: null });
  t.after(() => harness.lifecycle.dispose());
  for (const type of ["all", "branch_committed"] as const) {
    const list = rpcContract.diffList.output.parse(await harness.behavior.callRpc("diffList", { threadId: "thr_test", target: { type, mergeBaseBranch: "gone" } }));
    assert.deepEqual(list.files, []);
    assert.match(list.message ?? "", /no merge base with gone/);
    const read = rpcContract.diffRead.output.parse(await harness.behavior.callRpc("diffRead", { threadId: "thr_test", target: { type, mergeBaseBranch: "gone" }, path: "a.ts" }));
    assert.equal(read.kind, "unsupported");
    assert.match(read.reason, /no merge base with gone/);
  }
  const uncommitted = rpcContract.diffList.output.parse(await harness.behavior.callRpc("diffList", { threadId: "thr_test", target: { type: "uncommitted" } }));
  assert.equal(uncommitted.message, null);
  assert.equal(harness.inspection.sdk.callsTo("environments.diffFile").length, 0);
});

test("a truncated preview patch does not block loading the whole file", async (t) => {
  const { harness } = await diffHost({ truncated: true });
  t.after(() => harness.lifecycle.dispose());
  const result = rpcContract.diffRead.output.parse(await harness.behavior.callRpc("diffRead", { threadId: "thr_test", target: { type: "uncommitted" }, path: "a.ts" }));
  assert.equal(result.kind, "text");
  assert.equal(result.editable, true);
  assert.equal(result.oldContent, "old\n");
  assert.equal(result.newContent, "new\n");
});

test("a side that fails to read surfaces the daemon error without touching the working file", async (t) => {
  const { harness } = await diffHost({
    diffFile: async ({ path: filePath }) => { throw new Error(`Path "${filePath}" escapes read root`); },
  });
  t.after(() => harness.lifecycle.dispose());
  await assert.rejects(
    () => harness.behavior.callRpc("diffRead", { threadId: "thr_test", target: { type: "uncommitted" }, path: "a.ts" }),
    /escapes read root/,
  );
  assert.equal(harness.inspection.sdk.callsTo("files.read").length, 0);
});

test("an unmerged working-tree file stays read-only even without markers", async (t) => {
  const { harness } = await diffHost({ status: async () => statusWith([{ path: "a.ts", status: "U" }]) });
  t.after(() => harness.lifecycle.dispose());
  const result = rpcContract.diffRead.output.parse(await harness.behavior.callRpc("diffRead", { threadId: "thr_test", target: { type: "uncommitted" }, path: "a.ts" }));
  assert.equal(result.kind, "text");
  assert.equal(result.editable, false);
  assert.match(result.reason ?? "", /merge conflict/);
  assert.equal(result.sha256, "live-hash");
  assert.deepEqual(harness.inspection.sdk.callsTo("environments.status")[0]?.[0], { environmentId: "env_test" });
});

test("another file's conflict does not block this one", async (t) => {
  const { harness } = await diffHost({ status: async () => statusWith([{ path: "other.ts", status: "U" }, { path: "a.ts", status: "M" }]) });
  t.after(() => harness.lifecycle.dispose());
  const result = rpcContract.diffRead.output.parse(await harness.behavior.callRpc("diffRead", { threadId: "thr_test", target: { type: "uncommitted" }, path: "a.ts" }));
  assert.equal(result.kind, "text");
  assert.equal(result.editable, true);
});

test("an unavailable or failing workspace status keeps the diff read-only with the cause", async (t) => {
  const cases: { status: () => Promise<Status>; reason: RegExp }[] = [
    { status: async () => ({ outcome: "unavailable", failure: { code: "unknown", message: "daemon offline", workspacePath: "/workspace" } }), reason: /daemon offline/ },
    { status: async () => ({ outcome: "not_applicable", reason: "non_git_environment", message: "not a git workspace" }), reason: /not a git workspace/ },
    { status: async () => { throw new Error("status timed out"); }, reason: /status timed out/ },
  ];
  for (const { status, reason } of cases) {
    const { harness } = await diffHost({ status });
    t.after(() => harness.lifecycle.dispose());
    const result = rpcContract.diffRead.output.parse(await harness.behavior.callRpc("diffRead", { threadId: "thr_test", target: { type: "uncommitted" }, path: "a.ts" }));
    assert.equal(result.kind, "text");
    assert.equal(result.editable, false);
    assert.match(result.reason ?? "", /Cannot confirm/);
    assert.match(result.reason ?? "", reason);
  }
});

test("new and deleted files preserve absent sides, including empty files", async (t) => {
  for (const changeKind of ["added", "deleted"] as const) {
    const { harness } = await diffHost({ entry: { changeKind }, newContent: "", oldContent: "" });
    t.after(() => harness.lifecycle.dispose());
    const result = rpcContract.diffRead.output.parse(await harness.behavior.callRpc("diffRead", { threadId: "thr_test", target: { type: "uncommitted" }, path: "a.ts" }));
    assert.equal(result.kind, "text");
    assert.equal(result.oldContent, changeKind === "added" ? null : "");
    assert.equal(result.newContent, changeKind === "deleted" ? null : "");
    assert.equal(result.editable, changeKind === "added");
    assert.equal(harness.inspection.sdk.callsTo("environments.diffFile").length, 1);
  }
});

test("renames read the old path at the comparison base", async (t) => {
  const { harness } = await diffHost({ entry: { changeKind: "renamed", previousPath: "before.ts" } });
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.callRpc("diffRead", { threadId: "thr_test", target: { type: "all" }, path: "a.ts" });
  const calls = harness.inspection.sdk.callsTo("environments.diffFile");
  assert.deepEqual(calls[0]?.[0], { environmentId: "env_test", target: "all", mergeBaseRef: "abcdef0123456789", side: "old", path: "before.ts" });
  assert.deepEqual(harness.inspection.sdk.callsTo("environments.diffFiles")[0]?.[0], { environmentId: "env_test", target: "all", mergeBaseBranch: "main" });
});

test("binary and oversized comparisons never become editable whole documents", async (t) => {
  for (const options of [{ entry: { binary: true } }, { entry: { loadMode: "too_large" as const } }]) {
    const { harness } = await diffHost(options);
    t.after(() => harness.lifecycle.dispose());
    const result = rpcContract.diffRead.output.parse(await harness.behavior.callRpc("diffRead", { threadId: "thr_test", target: { type: "uncommitted" }, path: "a.ts" }));
    assert.equal(result.kind, "unsupported");
    assert.equal(harness.inspection.sdk.callsTo("files.read").length, 0);
    assert.equal(harness.inspection.sdk.callsTo("environments.diffFile").length, 0);
  }
});

test("diff access requires a current changed path and rejects traversal", async (t) => {
  const { harness } = await diffHost({ files: [] });
  t.after(() => harness.lifecycle.dispose());
  const input = { threadId: "thr_test", target: { type: "uncommitted" }, path: "a.ts" };
  assert.equal(rpcContract.diffRead.output.parse(await harness.behavior.callRpc("diffRead", input)).kind, "unsupported");
  await assert.rejects(() => harness.behavior.callRpc("diffRead", { ...input, path: "../outside" }), /cannot contain/);
  await assert.rejects(() => harness.behavior.callRpc("diffRead", { ...input, target: { type: "commit", sha: "--all" } }));
  assert.equal(harness.inspection.sdk.callsTo("files.read").length, 0);
});

test("unresolved conflict contents stay read-only with LF and CRLF", async (t) => {
  for (const newline of ["\n", "\r\n"]) {
    const { harness } = await diffHost({ newContent: ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> topic", ""].join(newline) });
    t.after(() => harness.lifecycle.dispose());
    const result = rpcContract.diffRead.output.parse(await harness.behavior.callRpc("diffRead", { threadId: "thr_test", target: { type: "uncommitted" }, path: "a.ts" }));
    assert.equal(result.kind, "text");
    assert.equal(result.editable, false);
    assert.equal(typeof result.reason, "string");
    assert.match(result.reason ?? "", /merge conflict/);
  }
});
