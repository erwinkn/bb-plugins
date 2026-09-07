import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { listLocalTree } from "./lib/local-tree.js";
import { CODE_THEME_CHOICES, codeThemeId, codeThemeLabel } from "./lib/themes.js";
import { diffEntrySchema, diffTargetSchema, hasConflictMarkers, isWorkingTreeTarget, type DiffTarget } from "./lib/diff-contract.js";

const MAX_EDITABLE_BYTES = 8 * 1024 * 1024;
const MAX_TREE_ENTRIES = 10_000;
/** Served bundle files by extension; anything else is refused. */
const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};
const PACKAGE_NAME = "bb-plugin-erwin-editor";
/** BB ids are `<prefix>_<alphanumerics>`; a thread id becomes a directory name under thread storage, so nothing path-like passes. */
const BB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const sourceSchema = z
  .object({
    kind: z.enum(["workspace", "host", "thread-storage"]),
    threadId: z.string().regex(BB_ID, "Invalid thread id").nullable(),
    environmentId: z.string().nullable(),
    projectId: z.string().nullable(),
    experimental_hostId: z.string().optional(),
  })
  .strict();

export type FileSource = z.infer<typeof sourceSchema>;

const fileSchema = z.object({ path: z.string().min(1), source: sourceSchema }).strict();

export const rpcContract = defineRpcContract({
  diffRevert: {
    input: z.object({ threadId: z.string().regex(BB_ID), target: diffTargetSchema,
      path: z.string().min(1).max(4096), expectedSha256: z.string().nullable(),
      expectedBaselineSha256: z.string().nullable(), confirmDelete: z.boolean(),
    }).strict(),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("deleted") }),
      z.object({ kind: z.literal("written"), content: z.string(), sha256: z.string(), absolutePath: z.string(), relativePath: z.string() }),
    ]),
  },
  diffCommits: {
    input: z.object({ threadId: z.string().regex(BB_ID), target: diffTargetSchema }).strict(),
    output: z.object({
      commits: z.array(z.object({ sha: z.string(), subject: z.string() })),
      baseBranch: z.string().nullable(), message: z.string().nullable(),
    }),
  },
  diffList: {
    input: z.object({ threadId: z.string().regex(BB_ID), target: diffTargetSchema }).strict(),
    output: z.object({
      source: sourceSchema, root: z.string(), label: z.string(), baseBranch: z.string().nullable(),
      target: diffTargetSchema, files: z.array(diffEntrySchema), truncated: z.boolean(), message: z.string().nullable(),
    }),
  },
  diffRead: {
    input: z.object({ threadId: z.string().regex(BB_ID), target: diffTargetSchema, path: z.string().min(1).max(4096) }).strict(),
    output: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("text"), source: sourceSchema, path: z.string(), previousPath: z.string().nullable(),
        oldContent: z.string().nullable(), newContent: z.string().nullable(), editable: z.boolean(), reason: z.string().nullable(),
        baselineSha256: z.string().nullable(),
        changeKind: diffEntrySchema.shape.changeKind, origin: diffEntrySchema.shape.origin,
        sha256: z.string().nullable(), absolutePath: z.string(), relativePath: z.string(),
      }),
      z.object({ kind: z.literal("unsupported"), reason: z.string() }),
    ]),
  },
  /** Where the editor bundle is served from; the URL stays valid for the plugin's life. */
  assets: {
    input: z.null(),
    output: z.object({ baseUrl: z.string() }),
  },
  /** The workspace a thread (or a project's default checkout) edits. */
  workspace: {
    input: z
      .object({ threadId: z.string().nullable(), projectId: z.string().nullable() })
      .strict(),
    output: z.object({
      source: sourceSchema,
      root: z.string(),
      /** Short label for the workspace: the branch, else the directory name. */
      label: z.string(),
    }),
  },
  read: {
    input: fileSchema,
    output: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("text"),
        content: z.string(),
        sha256: z.string(),
        absolutePath: z.string(),
        relativePath: z.string(),
      }),
      z.object({ kind: z.literal("unsupported"), reason: z.string() }),
    ]),
  },
  /**
   * The workspace's entries, or with `subpath` those under one directory
   * (paths stay workspace-relative). Directories marked `deferred` were not
   * descended into; list them with `subpath` when the user expands them.
   */
  tree: {
    input: z.object({ source: sourceSchema, subpath: z.string().optional() }).strict(),
    output: z.object({
      root: z.string(),
      entries: z.array(z.object({ path: z.string(), kind: z.enum(["file", "directory"]), deferred: z.literal(true).optional() })),
      truncated: z.boolean(),
    }),
  },
  write: {
    input: fileSchema.extend({ content: z.string(), expectedSha256: z.string().nullable() }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("written"), sha256: z.string() }),
      z.object({ outcome: z.literal("conflict"), currentSha256: z.string().nullable() }),
    ]),
  },
  /** Create an empty file or a directory; refuses to replace an existing path. */
  create: {
    input: fileSchema.extend({ kind: z.enum(["file", "directory"]) }),
    output: z.object({ path: z.string() }),
  },
  /** Move a file or directory to a new workspace-relative path. */
  rename: {
    input: fileSchema.extend({ newPath: z.string().min(1) }),
    output: z.object({ path: z.string() }),
  },
  /** Delete a file, or a directory with its contents. */
  remove: {
    input: fileSchema.extend({ kind: z.enum(["file", "directory"]) }),
    output: z.null(),
  },
  /** Persist one editor preference from the toolbar menu. */
  setSetting: {
    input: z.discriminatedUnion("key", [
      z.object({ key: z.literal("wordWrap"), value: z.boolean() }),
      z.object({ key: z.literal("lineNumbers"), value: z.boolean() }),
      z.object({ key: z.literal("autoSave"), value: z.enum(["off", "onBlur", "afterDelay"]) }),
      z.object({ key: z.literal("fileTreeSide"), value: z.enum(["left", "right"]) }),
      z.object({ key: z.literal("codeTheme"), value: z.enum(CODE_THEME_CHOICES.map((choice) => choice.label) as [string, ...string[]]) }),
    ]),
    output: z.null(),
  },
  /**
   * The shared plugin selection, with BB's theme id for callers that follow BB.
   */
  theme: {
    input: z.null(),
    output: z.object({ pair: z.string().nullable(), themeId: z.string() }),
  },
  /** Choose a predefined theme for both Files and Changes. */
  applyTheme: {
    input: z.object({ pair: z.enum(CODE_THEME_CHOICES.map((choice) => choice.id) as [string, ...string[]]) }),
    output: z.null(),
  },
});

/**
 * The plugin directory, whether this module runs as `server.ts` (path
 * install) or as `dist/server.js` (git install): the nearest ancestor whose
 * package.json names this plugin.
 */
export function findPluginRoot(start: string): string {
  let directory = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
        if (parsed.name === PACKAGE_NAME) return directory;
      } catch {}
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`could not locate the ${PACKAGE_NAME} package root from ${start}`);
}

function isBundleStale(pluginRoot: string, bundleDir: string): boolean {
  const builtAtMs = statSync(path.join(bundleDir, "editor.js")).mtimeMs;
  const entryDir = path.join(pluginRoot, "pierre-bundle");
  if (!existsSync(entryDir)) return false;
  const inputs = [
    path.join(pluginRoot, "scripts", "stage-assets.mjs"),
    path.join(pluginRoot, "package.json"),
    path.join(pluginRoot, "package-lock.json"),
    ...readdirSync(entryDir).map((name) => path.join(entryDir, name)),
  ];
  return inputs.some((input) => existsSync(input) && statSync(input).mtimeMs > builtAtMs);
}

/** Files under `dir`, as POSIX paths relative to it. */
function listFilesRecursively(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFilesRecursively(path.join(dir, entry.name), relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

async function ensureBundleDir(log: (message: string) => void): Promise<string> {
  const pluginRoot = findPluginRoot(path.dirname(fileURLToPath(import.meta.url)));
  const bundleDir = path.join(pluginRoot, "dist", "pierre");
  const built = existsSync(path.join(bundleDir, "editor.js"));
  if (built && !isBundleStale(pluginRoot, bundleDir)) return bundleDir;
  log(built ? "editor bundle is older than its sources; rebuilding it" : "editor bundle missing; building it");
  const script = path.join(pluginRoot, "scripts", "stage-assets.mjs");
  try {
    await import(`${new URL(`file://${script}`).href}?t=${Date.now()}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not build the editor bundle (${reason}); run \`npm run build:pierre\` in ${pluginRoot}`,
    );
  }
  if (!existsSync(path.join(bundleDir, "editor.js"))) {
    throw new Error(`the editor bundle build produced no ${bundleDir}/editor.js`);
  }
  return bundleDir;
}

function assertInsideWorkspace(relativePath: string): void {
  if (/(^|[\\/])\.\.([\\/]|$)/.test(relativePath)) throw new Error("The path cannot contain '..'");
  if (/^([\\/]|[A-Za-z]:)/.test(relativePath)) throw new Error("The path must be inside the workspace");
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    fontSize: {
      type: "number",
      label: "Font size",
      experimental_schema: z.number().int().min(9).max(24),
      default: 13,
    },
    wordWrap: { type: "boolean", label: "Wrap long lines", default: false },
    lineNumbers: { type: "boolean", label: "Show line numbers", default: true },
    codeTheme: {
      type: "select",
      label: "Code theme",
      description: "Syntax colors for Files and Changes. Follows BB's light or dark mode and keeps BB's background.",
      options: CODE_THEME_CHOICES.map((choice) => choice.label),
      default: "Follow BB",
    },
    autoSave: {
      type: "select",
      label: "Auto save",
      options: ["off", "onBlur", "afterDelay"],
      default: "off",
    },
    fileTreeSide: {
      type: "select",
      label: "File tree side",
      options: ["left", "right"],
      default: "right",
    },
  });

  // The bundle is served through the plugin's own HTTP routes, one per file
  // (routes match exact paths), so its URLs never expire: the page keeps one
  // Pierre module for its whole life, and its lazy chunks and workers resolve
  // against the same base at any later time. A preview lease would lapse
  // after an hour at most.
  let assetsBaseUrl = "";
  let assetsReady: Promise<void> | null = null;

  async function assets() {
    assetsReady ??= registerAssetRoutes().catch((error: unknown) => {
      assetsReady = null;
      throw error;
    });
    await assetsReady;
    return { baseUrl: assetsBaseUrl };
  }

  async function registerAssetRoutes() {
    const bundleDir = await ensureBundleDir((message) => bb.log.info(message));
    // Version the base path as well as chunks: browsers cache imported ESM
    // modules even when HTTP says no-cache. A plugin reload must load new code.
    const entries = await Promise.all(["editor.js", "worker.js"].map((name) => readFile(path.join(bundleDir, name))));
    const revision = createHash("sha256").update(entries[0]!).update(entries[1]!).digest("hex").slice(0, 16);
    const routeBase = `/pierre/${revision}`;
    assetsBaseUrl = `/api/v1/plugins/${bb.pluginId}/http${routeBase}`;
    const files = listFilesRecursively(bundleDir);
    let served = 0;
    for (const relative of files) {
      const type = ASSET_CONTENT_TYPES[path.extname(relative)];
      if (type === undefined) continue;
      const absolute = path.join(bundleDir, relative);
      // Chunks carry a content hash in their name; the entry files do not.
      const immutable = relative.startsWith("chunks/") || relative.startsWith("worker-chunks/");
      bb.http.route("GET", `${routeBase}/${relative}`, async () => {
        const body = await readFile(absolute);
        return new Response(body, {
          headers: {
            "content-type": type,
            "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
          },
        });
      });
      served += 1;
    }
    bb.log.info(`editor bundle: serving ${served} files from ${bundleDir}`);
  }

  let primaryHostId: string | null | undefined;

  /**
   * Whether `target` is a directory on the machine this plugin runs on: its
   * host is BB's primary host (or none, for thread storage) and the path
   * exists here. Anything else is read through BB's daemon.
   */
  async function isLocalWorkspace(target: { rootPath: string; hostId?: string }): Promise<boolean> {
    if (target.hostId !== undefined) {
      primaryHostId ??= (await bb.sdk.system.config()).primaryHostId;
      if (target.hostId !== primaryHostId) return false;
    }
    try {
      return statSync(target.rootPath).isDirectory();
    } catch {
      return false;
    }
  }

  async function threadStorageRoot(): Promise<string> {
    const override = process.env.BB_THREAD_STORAGE;
    if (override && override.trim().length > 0) return path.resolve(override);
    const { dataDir } = await bb.sdk.system.config();
    return path.join(dataDir, "thread-storage");
  }

  async function resolveTarget(
    source: FileSource,
    filePath: string,
  ): Promise<{ path: string; rootPath: string; hostId?: string }> {
    // Host files are addressed by absolute path; every other kind is relative
    // to a workspace root and must stay inside it.
    if (source.kind !== "host") assertInsideWorkspace(filePath);
    if (source.kind === "thread-storage") {
      if (source.threadId === null) throw new Error("This thread-storage file has no thread");
      const rootPath = path.join(await threadStorageRoot(), source.threadId);
      return { path: path.join(rootPath, filePath), rootPath };
    }
    if (source.environmentId === null && source.kind === "workspace") {
      if (source.projectId === null) throw new Error("This file has no environment or project");
      const project = await bb.sdk.projects.get({ projectId: source.projectId });
      const checkout =
        source.experimental_hostId === undefined
          ? (project.sources.find((entry) => entry.isDefault) ?? project.sources[0])
          : project.sources.find((entry) => entry.hostId === source.experimental_hostId);
      if (checkout === undefined) throw new Error("This project has no matching source checkout");
      return { path: path.join(checkout.path, filePath), rootPath: checkout.path, hostId: checkout.hostId };
    }
    if (source.environmentId === null) throw new Error("This file has no environment to resolve it against");
    const environment = await bb.sdk.environments.get({ environmentId: source.environmentId });
    if (source.kind === "host") {
      const api = path.win32.isAbsolute(filePath) ? path.win32 : path.posix;
      return {
        path: filePath,
        rootPath: api.dirname(filePath),
        ...(environment.hostId ? { hostId: environment.hostId } : {}),
      };
    }
    if (!environment.path) throw new Error("This environment has no workspace path");
    return {
      path: path.join(environment.path, filePath),
      rootPath: environment.path,
      ...(environment.hostId ? { hostId: environment.hostId } : {}),
    };
  }

  function relativeTo(root: string, target: string): string {
    const api = path.win32.isAbsolute(root) ? path.win32 : path.posix;
    return api.relative(root, target) || api.basename(target);
  }

  /**
   * The comparison's file list, fresh from the daemon. `diffRead` calls this
   * too, so a file's membership and metadata are never older than the read:
   * on a slow host that is one extra name-status and numstat run per open.
   */
  async function listDiff(threadId: string, requested: DiffTarget) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.environmentId === null) throw new Error("This thread has no workspace");
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (!environment.path) throw new Error("This workspace has no filesystem path");
    const baseBranch = environment.mergeBaseBranch ?? environment.baseBranch ?? environment.defaultBranch ?? null;
    const source: FileSource = {
      kind: "workspace", threadId, environmentId: thread.environmentId, projectId: thread.projectId,
      ...(environment.hostId ? { experimental_hostId: environment.hostId } : {}),
    };
    let target = requested;
    if (requested.type === "all" || requested.type === "branch_committed") {
      const branch = requested.mergeBaseBranch ?? baseBranch;
      if (!branch) throw new Error("Enter a base branch for this comparison");
      target = { ...requested, mergeBaseBranch: branch };
    }
    const query = target.type === "commit"
      ? { target: target.type, sha: target.sha }
      : target.type === "uncommitted"
        ? { target: target.type }
        : { target: target.type, mergeBaseBranch: target.mergeBaseBranch! };
    const result = await bb.sdk.environments.diffFiles({ environmentId: environment.id, ...query });
    // Without a merge base the daemon reports an empty, "available" comparison.
    const message = result.outcome === "available"
      ? (target.type === "all" || target.type === "branch_committed") && result.mergeBaseRef === null
        ? `HEAD has no merge base with ${target.mergeBaseBranch}. Check that the branch exists and shares history.`
        : null
      : result.outcome === "not_applicable" ? result.message : result.failure.message;
    return { source, environment, baseBranch, target, result, message };
  }

  /**
   * Why working-tree edits to `filePath` must wait, or null. Comparisons
   * fold git's `U` status into "modified", so an unmerged index shows only
   * in the workspace status, per file, and only for porcelain codes that
   * contain `U`. Known gap: a both-added (`AA`) entry reports as `A`; it is
   * caught by `hasConflictMarkers` unless its markers were stripped by hand.
   * Both-deleted (`DD`) entries are absent from disk and stay read-only.
   */
  async function conflictBlock(environmentId: string, filePath: string): Promise<string | null> {
    let status: Awaited<ReturnType<typeof bb.sdk.environments.status>>;
    try {
      status = await bb.sdk.environments.status({ environmentId });
    } catch (error) {
      return `Cannot confirm the workspace has no merge conflict: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (status.outcome !== "available") {
      const detail = status.outcome === "not_applicable" ? status.message : status.failure.message;
      return `Cannot confirm the workspace has no merge conflict: ${detail}`;
    }
    if (status.workspace.workingTree.files.some((file) => file.path === filePath && file.status === "U")) {
      return "Resolve this file's merge conflict in the file editor before editing this diff.";
    }
    return null;
  }

  async function readDiff({ threadId, target: requested, path: filePath }: { threadId: string; target: DiffTarget; path: string }) {
      assertInsideWorkspace(filePath);
      const { result, environment, source, target, message } = await listDiff(threadId, requested);
      if (result.outcome !== "available" || message !== null) return { kind: "unsupported" as const, reason: message ?? "This comparison is unavailable" };
      const entry = result.files.find((file) => file.path === filePath);
      if (!entry) return { kind: "unsupported" as const, reason: "This file is no longer in the comparison. Refresh the file list." };
      if (entry.binary) return { kind: "unsupported" as const, reason: "Binary file changed" };
      if (entry.loadMode === "too_large") return { kind: "unsupported" as const, reason: "This file is too large to compare" };
      if (entry.changeKind === "type_changed") return { kind: "unsupported" as const, reason: "The file type changed. Open the working file to inspect it." };
      // `initialPatches` is only a bounded preview; both sides load whole below.
      const query = target.type === "commit" ? { target: target.type, sha: target.sha }
        : target.type === "uncommitted" ? { target: target.type }
        : { target: target.type, mergeBaseRef: result.mergeBaseRef ?? "" };
      const empty = { content: "", contentEncoding: "utf8" as const, sizeBytes: 0 };
      const [oldFile, newFile] = await Promise.all([
        entry.changeKind === "added" || entry.origin === "untracked" ? empty : bb.sdk.environments.diffFile({ environmentId: environment.id, ...query, side: "old", path: entry.previousPath ?? filePath }),
        entry.changeKind === "deleted" ? empty : bb.sdk.environments.diffFile({ environmentId: environment.id, ...query, side: "new", path: filePath }),
      ]);
      if (oldFile.contentEncoding !== "utf8" || newFile.contentEncoding !== "utf8") return { kind: "unsupported" as const, reason: "This file is not text" };
      if (Math.max(oldFile.sizeBytes, newFile.sizeBytes) > MAX_EDITABLE_BYTES) return { kind: "unsupported" as const, reason: "This file is too large to compare" };
      const resolved = await resolveTarget(source, filePath);
      let editable = isWorkingTreeTarget(target) && entry.changeKind !== "deleted";
      let reason: string | null = editable ? null : entry.changeKind === "deleted" ? "Deleted files are read-only" : "This is a saved revision. Open the working file to edit it.";
      let sha256: string | null = null;
      if (editable) {
        const [live, blocked] = await Promise.all([bb.sdk.files.read(resolved), conflictBlock(environment.id, filePath)]);
        if (live.contentEncoding !== "utf8" || live.sizeBytes > MAX_EDITABLE_BYTES) return { kind: "unsupported" as const, reason: "The working file can no longer be edited as text" };
        sha256 = live.sha256;
        if (live.content !== newFile.content) {
          editable = false;
          reason = "The working file changed while loading. Refresh before editing.";
        } else if (blocked !== null) {
          editable = false;
          reason = blocked;
        } else if (hasConflictMarkers(live.content)) {
          editable = false;
          reason = "Resolve the merge conflict in the file editor before editing this diff.";
        }
      }
      return {
        kind: "text" as const, source, path: filePath, previousPath: entry.previousPath,
        oldContent: entry.changeKind === "added" || entry.origin === "untracked" ? null : oldFile.content,
        newContent: entry.changeKind === "deleted" ? null : newFile.content,
        baselineSha256: entry.changeKind === "added" || entry.origin === "untracked" ? null : createHash("sha256").update(oldFile.content).digest("hex"),
        changeKind: entry.changeKind, origin: entry.origin, editable, reason, sha256,
        absolutePath: resolved.path, relativePath: relativeTo(resolved.rootPath, resolved.path),
      };
    }

  bb.rpc.register(rpcContract, {
    async diffRevert(input) {
      if (!isWorkingTreeTarget(input.target)) throw new Error("Saved revisions are read-only");
      const data = await readDiff(input);
      if (data.kind !== "text") throw new Error(data.reason);
      if (!["modified", "added", "deleted"].includes(data.changeKind)) throw new Error("Reverting renames, copies and file type changes is not supported");
      if (data.baselineSha256 !== input.expectedBaselineSha256 || data.sha256 !== input.expectedSha256) {
        throw new Error("The comparison changed. Refresh before reverting.");
      }
      if (data.newContent !== null && !data.editable) throw new Error(data.reason ?? "This file is read-only");
      const target = await resolveTarget(data.source, data.path);
      if (data.oldContent === null) {
        if (!input.confirmDelete) throw new Error("Confirm deletion of this new file first");
        // The public remove API has no CAS parameter. Re-read immediately before
        // removal; rootPath confines the operation and recursive is always false.
        const live = await bb.sdk.files.read(target);
        if (live.sha256 !== input.expectedSha256) throw new Error("The file changed. Refresh before deleting.");
        await bb.sdk.files.remove({ ...target, recursive: false });
        return { kind: "deleted" as const };
      }
      if (data.newContent === null) {
        const blocked = await conflictBlock(data.source.environmentId!, data.path);
        if (blocked) throw new Error(blocked);
      }
      const written = await bb.sdk.files.write({ ...target, content: data.oldContent, contentEncoding: "utf8",
        createParents: true, expectedSha256: input.expectedSha256 });
      if (written.outcome !== "written") throw new Error("The file changed. Refresh before reverting.");
      return { kind: "written" as const, content: data.oldContent, sha256: written.sha256,
        absolutePath: data.absolutePath, relativePath: data.relativePath };
    },
    async diffCommits({ threadId, target }) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.environmentId === null) throw new Error("This thread has no workspace");
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      const baseBranch = ((target.type === "all" || target.type === "branch_committed") ? target.mergeBaseBranch : undefined)
        ?? environment.mergeBaseBranch ?? environment.baseBranch ?? environment.defaultBranch ?? null;
      const status = await bb.sdk.environments.status({ environmentId: environment.id, ...(baseBranch ? { mergeBaseBranch: baseBranch } : {}) });
      if (status.outcome !== "available") {
        return { commits: [], baseBranch, message: status.outcome === "not_applicable" ? status.message : status.failure.message };
      }
      const base = status.workspace.mergeBase;
      if (!base?.baseRef) return { commits: [], baseBranch, message: "No base comparison available" };
      // The SDK returns Git traversal order, oldest first. Preserve that order
      // in reverse, rather than sorting by author dates that can be misleading.
      return {
        commits: base.commits.slice(-MAX_TREE_ENTRIES).reverse().map(({ sha, subject }) => ({ sha, subject: subject.slice(0, 500) })),
        baseBranch: base.mergeBaseBranch,
        message: base.commits.length > MAX_TREE_ENTRIES ? `Showing the latest ${MAX_TREE_ENTRIES} commits` : null,
      };
    },
    async diffList({ threadId, target }) {
      const data = await listDiff(threadId, target);
      const { result, environment } = data;
      return {
        source: data.source, root: environment.path!,
        label: environment.branchName ?? environment.name ?? path.basename(environment.path!),
        baseBranch: data.baseBranch, target: data.target,
        files: result.outcome === "available" ? result.files.slice(0, MAX_TREE_ENTRIES) : [],
        truncated: result.outcome === "available" && (result.truncated || result.files.length > MAX_TREE_ENTRIES),
        message: data.message,
      };
    },

    diffRead: readDiff,
    assets: () => assets(),

    async workspace({ threadId, projectId }) {
      if (threadId !== null) {
        const thread = await bb.sdk.threads.get({ threadId });
        const environmentId = thread.environmentId;
        const source: FileSource = { kind: "workspace", threadId, environmentId, projectId: thread.projectId };
        if (environmentId !== null) {
          const environment = await bb.sdk.environments.get({ environmentId });
          if (!environment.path) throw new Error("This thread's environment has no workspace path");
          return {
            source,
            root: environment.path,
            label: environment.branchName ?? environment.name ?? path.basename(environment.path),
          };
        }
        const target = await resolveTarget(source, ".");
        return { source, root: target.rootPath, label: path.basename(target.rootPath) };
      }
      if (projectId === null) throw new Error("Select a project to browse its files");
      const source: FileSource = { kind: "workspace", threadId: null, environmentId: null, projectId };
      const target = await resolveTarget(source, ".");
      return { source, root: target.rootPath, label: path.basename(target.rootPath) };
    },

    async read({ path: filePath, source }) {
      const target = await resolveTarget(source, filePath);
      const file = await bb.sdk.files.read(target);
      if (file.contentEncoding !== "utf8") return { kind: "unsupported" as const, reason: "This file is not text" };
      if (file.sizeBytes > MAX_EDITABLE_BYTES) {
        return {
          kind: "unsupported" as const,
          reason: `This file is too large to edit (${Math.round(file.sizeBytes / 1024 / 1024)} MB)`,
        };
      }
      return {
        kind: "text" as const,
        content: file.content,
        sha256: file.sha256,
        absolutePath: target.path,
        relativePath: relativeTo(target.rootPath, target.path),
      };
    },

    async tree({ source, subpath = "" }) {
      assertInsideWorkspace(subpath);
      const target = await resolveTarget(source, ".");
      const clean = subpath.replace(/^\/+|\/+$/g, "");
      if (await isLocalWorkspace(target)) {
        const listing = await listLocalTree(target.rootPath, clean, MAX_TREE_ENTRIES);
        return { root: target.rootPath, ...listing };
      }
      // Another host: BB's daemon lists it, without hidden entries, node_modules, or symlinks.
      const result = await bb.sdk.files.listPaths({
        path: clean === "" ? target.rootPath : path.posix.join(target.rootPath, clean),
        includeFiles: true,
        includeDirectories: true,
        limit: MAX_TREE_ENTRIES,
        ...(target.hostId !== undefined ? { hostId: target.hostId } : {}),
      });
      return {
        root: target.rootPath,
        entries: result.paths.map((entry) => ({ path: clean === "" ? entry.path : `${clean}/${entry.path}`, kind: entry.kind })),
        truncated: result.truncated,
      };
    },

    async write({ path: filePath, source, content, expectedSha256 }) {
      const target = await resolveTarget(source, filePath);
      // Our RPC uses null for an explicit overwrite. BB's file API uses an
      // omitted hash for that operation; null means "create only if absent".
      const result = await bb.sdk.files.write({
        ...target,
        content,
        contentEncoding: "utf8",
        ...(expectedSha256 === null ? {} : { expectedSha256 }),
      });
      return result.outcome === "written"
        ? { outcome: "written" as const, sha256: result.sha256 }
        : { outcome: "conflict" as const, currentSha256: result.currentSha256 };
    },

    async create({ path: filePath, source, kind }) {
      assertInsideWorkspace(filePath);
      const target = await resolveTarget(source, filePath);
      const hostId = target.hostId === undefined ? {} : { hostId: target.hostId };
      if (await exists(target.path, hostId)) throw new Error(`${filePath} already exists`);
      if (kind === "directory") {
        await bb.sdk.files.mkdir({ path: target.path, recursive: true, ...hostId });
      } else {
        const result = await bb.sdk.files.write({
          path: target.path,
          content: "",
          contentEncoding: "utf8",
          createParents: true,
          // Protect the gap between the existence check and the write.
          expectedSha256: null,
          ...hostId,
        });
        if (result.outcome !== "written") throw new Error(`${filePath} already exists`);
      }
      return { path: filePath };
    },

    async rename({ path: filePath, source, newPath }) {
      assertInsideWorkspace(filePath);
      assertInsideWorkspace(newPath);
      const from = await resolveTarget(source, filePath);
      const to = await resolveTarget(source, newPath);
      const hostId = from.hostId === undefined ? {} : { hostId: from.hostId };
      if (from.path === to.path) return { path: newPath };
      if (await exists(to.path, hostId)) throw new Error(`${newPath} already exists`);
      await bb.sdk.files.move({ sourcePath: from.path, destinationPath: to.path, ...hostId });
      return { path: newPath };
    },

    async remove({ path: filePath, source, kind }) {
      assertInsideWorkspace(filePath);
      const target = await resolveTarget(source, filePath);
      if (target.path === target.rootPath) throw new Error("The workspace root cannot be deleted");
      const hostId = target.hostId === undefined ? {} : { hostId: target.hostId };
      await bb.sdk.files.remove({ path: target.path, recursive: kind === "directory", ...hostId });
      return null;
    },

    async setSetting(input) {
      await settings.experimental_set({ [input.key]: input.value });
      return null;
    },

    async theme() {
      const { themeId } = await bb.sdk.theme.get();
      const { codeTheme } = await settings.get();
      return { pair: codeThemeId(codeTheme), themeId };
    },

    async applyTheme({ pair }) {
      await settings.experimental_set({ codeTheme: codeThemeLabel(pair) });
      return null;
    },
  });

  /** Whether a file or directory exists; a directory reads with an error too, so mkdir stays idempotent. */
  async function exists(absolutePath: string, hostId: { hostId?: string }): Promise<boolean> {
    return bb.sdk.files
      .read({ path: absolutePath, ...hostId })
      .then(() => true)
      .catch((error: unknown) => /EISDIR|is a directory/i.test(error instanceof Error ? error.message : String(error)));
  }
}
