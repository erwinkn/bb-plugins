import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost, experimental_scanPublicSdkOnly, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin, { findPluginRoot, pathApiFor, rpcContract } from "./server";

const here = fileURLToPath(new URL(".", import.meta.url));

test("relative paths use POSIX separators for POSIX roots and Windows ones only for drive or UNC roots", () => {
  assert.equal(pathApiFor("/tmp/workspace").relative("/tmp/workspace", "/tmp/workspace/docs/a.md"), "docs/a.md");
  assert.equal(pathApiFor("C:\\work").relative("C:\\work", "C:\\work\\docs\\a.md"), "docs\\a.md");
  assert.equal(pathApiFor("\\\\server\\share").sep, "\\");
});

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
  assert.deepEqual(Object.keys(rpcContract).sort(), ["applyTheme", "assets", "create", "diffCommits", "diffList", "diffRead", "diffRevert", "previewBase", "read", "remove", "rename", "setSetting", "theme", "tree", "unwatch", "watch", "workspace", "write"]);
});

test("settings and the picker share predefined themes without changing BB's global theme", async (t) => {
  let { bb, harness } = createFakePluginHost({
    pluginId: "erwin-editor",
    settings: { codePalette: "conductor" }, // An older installation falls back to Follow BB.
    sdk: { theme: { get: async () => ({ themeId: "default" }) } },
  });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const readTheme = async () => rpcContract.theme.output.parse(await harness.behavior.callRpc("theme", null));
  assert.deepEqual(await readTheme(), { pair: "bb", themeId: "default" });
  await harness.behavior.callRpc("applyTheme", { pair: "tokyo-night" });
  assert.deepEqual(await readTheme(), { pair: "tokyo-night", themeId: "default" });
  await harness.behavior.setSettings({ codeTheme: "GitHub" });
  assert.deepEqual(await readTheme(), { pair: "github", themeId: "default" });
  await harness.behavior.callRpc("setSetting", { key: "codeTheme", value: "Catppuccin Mocha" });
  assert.equal((await readTheme()).pair, "catppuccin-mocha");
  assert.equal(harness.inspection.sdk.callsTo("theme.set").length, 0);
  ({ bb, harness } = await harness.lifecycle.reload(plugin));
  assert.equal((await readTheme()).pair, "catppuccin-mocha");
  await harness.behavior.callRpc("applyTheme", { pair: "bb" });
  assert.equal((await readTheme()).pair, "bb");
  await assert.rejects(() => harness.behavior.callRpc("applyTheme", { pair: "conductor" }));
  await assert.rejects(() => harness.behavior.callRpc("setSetting", { key: "codeTheme", value: "Unknown" }));
  assert.equal(harness.inspection.sdk.callsTo("theme.set").length, 0);
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
      /^@radix-ui\/react-(dropdown-menu|slot)$/,
      /^shiki\//,
      /^@shikijs\/(langs|themes)\//,
      /^@pierre\/theme\//,
      /^@pierre\/diffs(\/|$)/,
      /^@pierre\/trees$/,
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

/** BB's actual write preconditions: omitted = force, null = absent, string = CAS. */
async function fileWriteHost(initialContent: string | null, createDuringRead = false) {
  let disk = initialContent;
  const digest = () => disk === null ? null : createHash("sha256").update(disk).digest("hex");
  const { bb, harness } = createFakePluginHost({
    pluginId: "erwin-editor",
    sdk: {
      environments: { get: async () => environment },
      files: {
        read: async ({ path: filePath }) => {
          if (disk === null) {
            if (createDuringRead) disk = "another process created this";
            throw new Error("ENOENT: file does not exist");
          }
          return { path: filePath, content: disk, contentEncoding: "utf8", sha256: digest()!, sizeBytes: Buffer.byteLength(disk), mimeType: "text/plain" };
        },
        write: async ({ expectedSha256, content }) => {
          const currentSha256 = digest();
          if (expectedSha256 !== undefined && expectedSha256 !== currentSha256) {
            return { outcome: "conflict", currentSha256 };
          }
          disk = content;
          return { outcome: "written", sha256: digest()! };
        },
      },
    },
  });
  await plugin(bb);
  const source = { kind: "workspace" as const, threadId: null, environmentId: environment.id, projectId: environment.projectId };
  return { harness, source, content: () => disk, digest };
}

test("explicit overwrite omits the SDK hash while normal saves retain CAS", async (t) => {
  const host = await fileWriteHost("disk version");
  t.after(() => host.harness.lifecycle.dispose());
  const write = (content: string, expectedSha256: string | null) => host.harness.behavior.callRpc("write", {
    source: host.source, path: "a.ts", content, expectedSha256,
  });
  const originalHash = host.digest()!;
  const normal = rpcContract.write.output.parse(await write("normal save", originalHash));
  assert.equal(normal.outcome, "written");
  assert.equal(host.content(), "normal save");
  const stale = rpcContract.write.output.parse(await write("must not replace", originalHash));
  assert.equal(stale.outcome, "conflict");
  assert.equal(host.content(), "normal save");
  const forced = rpcContract.write.output.parse(await write("explicit overwrite", null));
  assert.equal(forced.outcome, "written");
  assert.equal(host.content(), "explicit overwrite");
  const calls = host.harness.inspection.sdk.callsTo("files.write");
  assert.equal((calls[0]?.[0] as { expectedSha256: string }).expectedSha256, originalHash);
  assert.equal(Object.hasOwn(calls[2]?.[0] as object, "expectedSha256"), false);
});

test("create writes only an absent file and preserves a file created after its check", async (t) => {
  const absent = await fileWriteHost(null);
  const raced = await fileWriteHost(null, true);
  t.after(() => absent.harness.lifecycle.dispose());
  t.after(() => raced.harness.lifecycle.dispose());
  assert.deepEqual(await absent.harness.behavior.callRpc("create", { source: absent.source, path: "new.txt", kind: "file" }), { path: "new.txt" });
  assert.equal(absent.content(), "");
  assert.equal((absent.harness.inspection.sdk.callsTo("files.write")[0]?.[0] as { expectedSha256: null }).expectedSha256, null);
  await assert.rejects(() => raced.harness.behavior.callRpc("create", { source: raced.source, path: "new.txt", kind: "file" }), /already exists/);
  assert.equal(raced.content(), "another process created this");
});

test("previewBase leases the workspace root on the file's host and refuses paths outside it", async (t) => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "erwin-editor",
    sdk: {
      environments: { get: async () => environment },
      files: { createPreview: async () => ({ baseUrl: "/api/v1/files/preview/lease1", expiresAtMs: 1_000 }) },
    },
  });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const source = { kind: "workspace", threadId: null, environmentId: environment.id, projectId: environment.projectId };
  const lease = rpcContract.previewBase.output.parse(await harness.behavior.callRpc("previewBase", { path: "docs/guide.md", source }));
  assert.deepEqual(lease, { baseUrl: "/api/v1/files/preview/lease1", expiresAtMs: 1_000 });
  const args = harness.inspection.sdk.callsTo("files.createPreview")[0]?.[0] as { rootPath: string; hostId?: string; ttlMs?: number };
  assert.equal(args.rootPath, "/workspace");
  assert.equal(args.hostId, "host_remote");
  assert.ok((args.ttlMs ?? 0) > 0);
  await assert.rejects(() => harness.behavior.callRpc("previewBase", { path: "../guide.md", source }), /cannot contain/);
});

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
  write?: BbPluginApi["sdk"]["files"]["write"];
  remove?: BbPluginApi["sdk"]["files"]["remove"];
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
        ...(options.write ? { write: options.write } : {}),
        ...(options.remove ? { remove: options.remove } : {}),
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

test("commit menu returns every branch commit newest first and uses the selected base", async (t) => {
  const status = statusWith([]);
  assert.equal(status.outcome, "available");
  if (status.outcome !== "available") return;
  status.workspace.mergeBase = {
    aheadCount: 13, behindCount: 0, baseRef: "abcdef0", mergeBaseBranch: "release/next",
    hasCommittedUnmergedChanges: true, files: [], insertions: 1, deletions: 0, lineStatsComplete: true,
    commits: Array.from({ length: 13 }, (_, i) => ({
      sha: String(i).padStart(40, "0"), shortSha: String(i), subject: `Commit ${i}`,
      authorName: "Author", authoredAt: 13 - i,
    })),
  };
  const { harness } = await diffHost({ status: async () => status });
  t.after(() => harness.lifecycle.dispose());
  const result = rpcContract.diffCommits.output.parse(await harness.behavior.callRpc("diffCommits", {
    threadId: "thr_test", target: { type: "branch_committed", mergeBaseBranch: "release/next" },
  }));
  assert.equal(result.commits.length, 13);
  assert.equal(result.commits[0]?.subject, "Commit 12");
  assert.equal(result.commits[12]?.subject, "Commit 0");
  assert.equal(result.baseBranch, "release/next");
  assert.equal(result.message, null);
  assert.deepEqual(harness.inspection.sdk.callsTo("environments.status")[0]?.[0], {
    environmentId: "env_test", mergeBaseBranch: "release/next",
  });
  assert.equal(harness.inspection.sdk.callsTo("environments.diffFiles").length, 0);
  assert.equal(harness.inspection.sdk.callsTo("files.read").length, 0);
});

test("commit menu distinguishes no base, no commits, and an unavailable workspace", async (t) => {
  for (const status of [
    statusWith([]),
    { outcome: "not_applicable", message: "Not a Git workspace" } as Status,
  ]) {
    const { harness } = await diffHost({ status: async () => status });
    t.after(() => harness.lifecycle.dispose());
    const result = rpcContract.diffCommits.output.parse(await harness.behavior.callRpc("diffCommits", {
      threadId: "thr_test", target: { type: "uncommitted" },
    }));
    assert.deepEqual(result.commits, []);
    assert.ok(result.message);
    assert.equal(result.baseBranch, "main");
  }
  const status = statusWith([]);
  if (status.outcome !== "available") throw new Error("invalid fixture");
  status.workspace.mergeBase = {
    aheadCount: 0, behindCount: 0, baseRef: "abcdef0", mergeBaseBranch: "main", commits: [],
    hasCommittedUnmergedChanges: false, files: [], insertions: 0, deletions: 0, lineStatsComplete: true,
  };
  const { harness } = await diffHost({ status: async () => status });
  t.after(() => harness.lifecycle.dispose());
  const result = rpcContract.diffCommits.output.parse(await harness.behavior.callRpc("diffCommits", {
    threadId: "thr_test", target: { type: "commit", sha: "abcdef0" },
  }));
  assert.deepEqual(result.commits, []);
  assert.equal(result.message, null);
});

const baselineHash = createHash("sha256").update("old\n").digest("hex");
const revertInput = { threadId: "thr_test", target: { type: "uncommitted" }, path: "a.ts",
  expectedSha256: "live-hash", expectedBaselineSha256: baselineHash, confirmDelete: false };

test("file revert writes the baseline with CAS and preserves host confinement", async (t) => {
  const { harness } = await diffHost({ write: async (args) => {
    assert.equal(args.content, "old\n"); assert.equal(args.expectedSha256, "live-hash");
    assert.equal(args.hostId, "host_remote"); assert.equal(args.rootPath, "/workspace");
    return { outcome: "written", sha256: baselineHash, sizeBytes: 4 };
  } });
  t.after(() => harness.lifecycle.dispose());
  const result = rpcContract.diffRevert.output.parse(await harness.behavior.callRpc("diffRevert", revertInput));
  assert.equal(result.kind, "written");
});

test("file revert refuses stale files, changed baselines, snapshots and conflicts", async (t) => {
  const { harness } = await diffHost(); t.after(() => harness.lifecycle.dispose());
  for (const input of [
    { ...revertInput, expectedSha256: "outdated" },
    { ...revertInput, expectedBaselineSha256: "outdated" },
    { ...revertInput, target: { type: "commit", sha: "abcdef0" } },
    { ...revertInput, path: "../a.ts" },
  ]) await assert.rejects(() => harness.behavior.callRpc("diffRevert", input));
  assert.equal(harness.inspection.sdk.callsTo("files.write").length, 0);
  assert.equal(harness.inspection.sdk.callsTo("files.remove").length, 0);
  const conflict = await diffHost({ status: async () => statusWith([{ path: "a.ts", status: "U" }]) });
  t.after(() => conflict.harness.lifecycle.dispose());
  await assert.rejects(() => conflict.harness.behavior.callRpc("diffRevert", revertInput), /conflict/);
});

test("restore creates only an absent file and refuses a concurrent creation", async (t) => {
  let exists = false;
  const { harness } = await diffHost({ entry: { changeKind: "deleted" }, write: async (args) => {
    assert.equal(args.expectedSha256, null);
    if (exists) return { outcome: "conflict", currentSha256: "concurrent" };
    exists = true; return { outcome: "written", sha256: baselineHash, sizeBytes: 4 };
  } });
  t.after(() => harness.lifecycle.dispose());
  const input = { ...revertInput, expectedSha256: null };
  await harness.behavior.callRpc("diffRevert", input);
  await assert.rejects(() => harness.behavior.callRpc("diffRevert", input), /file changed/);
});

test("deleting a new file requires confirmation and never removes recursively", async (t) => {
  const { harness } = await diffHost({ entry: { changeKind: "added", origin: "untracked" }, remove: async () => ({ ok: true }) });
  t.after(() => harness.lifecycle.dispose());
  const input = { ...revertInput, expectedBaselineSha256: null };
  await assert.rejects(() => harness.behavior.callRpc("diffRevert", input), /Confirm deletion/);
  assert.equal(harness.inspection.sdk.callsTo("files.remove").length, 0);
  await harness.behavior.callRpc("diffRevert", { ...input, confirmDelete: true });
  assert.deepEqual(harness.inspection.sdk.callsTo("files.remove")[0]?.[0], {
    path: "/workspace/a.ts", rootPath: "/workspace", hostId: "host_remote", recursive: false,
  });
});

test("watch registers the workspace root on its host, relays changes with sequence numbers, and stops when unwatched", async (t) => {
  const hostCalls: { method: string; input: unknown; hostId: string }[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "erwin-editor",
    sdk: { environments: { get: async () => environment } },
    experimental_callHostRpc: async (call) => {
      hostCalls.push(call);
      const roots = (call.input as { roots: string[] }).roots;
      return { watching: roots.filter((root) => root !== "/broken"), failed: roots.filter((root) => root === "/broken").map((rootPath) => ({ rootPath, message: "no watcher" })) };
    },
  });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const source = { kind: "workspace", threadId: null, environmentId: environment.id, projectId: environment.projectId };
  const first = rpcContract.watch.output.parse(await harness.behavior.callRpc("watch", { source, clientId: "page-1" }));
  assert.equal(typeof first.root, "string");
  assert.ok(first.ttlMs > 0);
  assert.deepEqual(hostCalls, [{ method: "syncWatches", input: { roots: ["/workspace"] }, hostId: "host_remote" }]);

  // A second page on the same root shares the watch; no new host call.
  const second = rpcContract.watch.output.parse(await harness.behavior.callRpc("watch", { source, clientId: "page-2" }));
  assert.equal(second.root, first.root);
  assert.equal(hostCalls.length, 2);
  assert.deepEqual(hostCalls[1]!.input, { roots: ["/workspace"] });

  await harness.behavior.experimental_emitHostSignal("host_remote", "changed", {
    rootPath: "/workspace", kind: "changed",
    paths: [{ path: "src/a.ts", type: "update" }],
  });
  await harness.behavior.experimental_emitHostSignal("host_remote", "changed", { rootPath: "/workspace", kind: "rescan", paths: [] });
  await harness.behavior.experimental_emitHostSignal("host_remote", "changed", { rootPath: "/unknown", kind: "rescan", paths: [] });
  assert.deepEqual(harness.inspection.realtimeSignals.map((signal) => [signal.channel, signal.payload]), [
    ["files-changed", { root: first.root, kind: "changed", changes: [{ path: "src/a.ts", type: "update" }], seq: 1 }],
    ["files-changed", { root: first.root, kind: "rescan", changes: [], seq: 2 }],
  ]);

  // The worker died: open files reload, and the watch is asked for again.
  await harness.behavior.experimental_emitHostWorkerExit("host_remote");
  assert.equal(harness.inspection.realtimeSignals.at(-1)?.payload && (harness.inspection.realtimeSignals.at(-1)!.payload as { kind: string }).kind, "rescan");
  assert.deepEqual(hostCalls.at(-1)?.input, { roots: ["/workspace"] });

  await harness.behavior.callRpc("unwatch", { source, clientId: "page-1" });
  assert.deepEqual(hostCalls.at(-1)?.input, { roots: ["/workspace"] }, "one page left: the watch stays");
  const callsBefore = hostCalls.length;
  await harness.behavior.callRpc("unwatch", { source, clientId: "page-2" });
  assert.deepEqual(hostCalls.at(-1)?.input, { roots: [] });
  assert.equal(hostCalls.length, callsBefore + 1);
});

test("watch reports no root when the host cannot watch, and keeps the registration for a later host", async (t) => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "erwin-editor",
    sdk: { environments: { get: async () => environment } },
    experimental_callHostRpc: async () => { throw new Error("host offline"); },
  });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const source = { kind: "workspace", threadId: null, environmentId: environment.id, projectId: environment.projectId };
  const result = rpcContract.watch.output.parse(await harness.behavior.callRpc("watch", { source, clientId: "page-1" }));
  assert.equal(result.root, null);
});
