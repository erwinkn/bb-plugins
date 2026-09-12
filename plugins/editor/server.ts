import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { listLocalFiles, listLocalTree } from "./lib/local-tree.js";
import { fuzzyScore } from "./lib/file-tree.js";
import { CODE_THEME_CHOICES, codeThemeId, codeThemeLabel } from "./lib/themes.js";
import { diffEntrySchema, diffTargetSchema, hasConflictMarkers, isWorkingTreeTarget, type DiffTarget } from "./lib/diff-contract.js";
import { FILES_CHANGED_CHANNEL, watchContract, watchSignals, type FilesChangedSignal } from "./lib/watch-contract.js";
import { WatchRegistry, WATCH_TTL_MS } from "./lib/watch-registry.js";

const MAX_EDITABLE_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_FILES = 10_000;
const MAX_COMMITS = 10_000;
const MAX_SUBJECT_CHARS = 500;
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

/** How long a Markdown preview's image lease lasts before the client renews it. */
const PREVIEW_LEASE_MS = 30 * 60 * 1000;

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
  /**
   * Ask for change notices for a source's root. The answer names the root
   * the `files-changed` signal will carry, or null when the root's host
   * cannot watch it; polling then remains the only path. A client renews
   * before the registration expires and unwatches when it leaves.
   */
  watch: {
    input: z.object({ source: sourceSchema, clientId: z.string().min(1).max(64) }).strict(),
    output: z.object({ root: z.string().nullable(), ttlMs: z.number() }).strict(),
  },
  unwatch: {
    input: z.object({ source: sourceSchema, clientId: z.string().min(1).max(64) }).strict(),
    output: z.null(),
  },
  /**
   * A temporary URL base that serves the files under the root of `path`, for
   * the images a Markdown preview refers to. It expires; ask again after that.
   */
  previewBase: {
    input: fileSchema,
    output: z.object({ baseUrl: z.string(), expiresAtMs: z.number() }),
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
   * The entries directly inside one workspace directory (paths stay
   * workspace-relative). Listings are a single level, the way code editors
   * resolve them: every directory comes back `deferred` and lists with
   * `subpath` when the user expands it, so no listing is ever capped by
   * workspace size.
   */
  tree: {
    input: z.object({ source: sourceSchema, subpath: z.string().optional() }).strict(),
    output: z.object({
      root: z.string(),
      entries: z.array(z.object({ path: z.string(), kind: z.enum(["file", "directory"]), deferred: z.literal(true).optional() })),
    }),
  },
  /**
   * Quick open's file search: workspace-relative paths fuzzy-matched against
   * `query`, best first. The workspace is searched on demand rather than from
   * the tree's listing, so files in unopened directories match too.
   */
  search: {
    input: z.object({
      source: sourceSchema,
      query: z.string().max(512),
      limit: z.number().int().min(1).max(200).optional(),
    }).strict(),
    output: z.object({
      matches: z.array(z.object({ path: z.string() })),
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

/** The committed browser assets. Installation and first use never build them. */
export function pierreAssetsDir(pluginRoot: string): string {
  const bundleDir = path.join(pluginRoot, "assets", "pierre");
  for (const entry of ["editor.js", "worker.js"]) {
    if (!existsSync(path.join(bundleDir, entry))) {
      throw new Error(`Missing prebuilt Pierre asset ${entry}; rebuild and commit assets/pierre with npm run build:pierre`);
    }
  }
  return bundleDir;
}

/**
 * The path API for an absolute path from a host: Windows for a drive or UNC
 * path, POSIX otherwise. (`path.win32.isAbsolute` accepts `/tmp` too, and
 * would then produce backslashes in relative paths.)
 */
export function pathApiFor(absolutePath: string): path.PlatformPath {
  return /^([A-Za-z]:[\\/]|\\\\)/.test(absolutePath) ? path.win32 : path.posix;
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
      default: 12,
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
    bbDiffs: {
      type: "boolean",
      label: "Draw BB's diffs",
      description: "Render the timeline's file diffs and the diff panel's bodies with this viewer instead of BB's.",
      default: true,
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
    const bundleDir = pierreAssetsDir(findPluginRoot(path.dirname(fileURLToPath(import.meta.url))));
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
  /** BB's primary host: where a path with no host of its own lives. */
  async function primaryHost(): Promise<string | null> {
    primaryHostId ??= (await bb.sdk.system.config()).primaryHostId;
    return primaryHostId;
  }

  // File watching. The host module keeps a native watch per workspace root;
  // the registry here remembers which clients asked for which root, and every
  // batch of changes goes out as one realtime signal that names the root.
  const watchHost = bb.hosts.experimental_client({ contract: watchContract, experimental_signals: watchSignals });
  const watches = new WatchRegistry();
  const syncingHosts = new Map<string, Promise<void>>();

  /** Make one host's watches match the registry, coalescing concurrent asks. */
  function syncHost(hostId: string): Promise<void> {
    const pending = syncingHosts.get(hostId);
    if (pending !== undefined) return pending;
    const run = (async () => {
      const roots = watches.rootsOn(hostId);
      const result = await watchHost.call("syncWatches", { roots }, { hostId });
      watches.markWatching(hostId, result.watching);
      for (const failure of result.failed) bb.log.warn(`file watch failed for ${failure.rootPath}: ${failure.message}`);
    })().finally(() => syncingHosts.delete(hostId));
    syncingHosts.set(hostId, run);
    return run;
  }

  /** Drops registrations nobody renewed and lets their hosts stop watching. */
  async function pruneWatches(): Promise<void> {
    for (const hostId of watches.prune(Date.now())) await syncHost(hostId).catch(() => undefined);
  }

  // Quick open's file index for local workspaces: one recursive walk per
  // root, reused across keystrokes. A watch notice that can add or remove
  // names (a rescan, or create/delete paths) drops it; it also expires on
  // its own for roots nobody watches.
  const filesIndexes = new Map<string, { files: string[]; expiresAt: number }>();
  const FILES_INDEX_TTL_MS = 30 * 1000;
  async function localFilesIndex(rootPath: string): Promise<string[]> {
    const now = Date.now();
    const cached = filesIndexes.get(rootPath);
    if (cached !== undefined && cached.expiresAt > now) return cached.files;
    for (const [key, entry] of filesIndexes) if (entry.expiresAt <= now) filesIndexes.delete(key);
    const files = await listLocalFiles(rootPath);
    filesIndexes.set(rootPath, { files, expiresAt: now + FILES_INDEX_TTL_MS });
    return files;
  }

  // Remote directory listings: every expand is a round trip to the host, so
  // resolved levels are cached the way VS Code keeps resolved explorer items.
  // A watch notice that can add or remove names drops the root's levels; the
  // TTL covers roots nobody watches. Root loads always ask the daemon —
  // opening or refreshing the tree is when freshness matters — and refill it.
  type DirListing = Awaited<ReturnType<typeof bb.sdk.hosts.directory>>;
  const dirListings = new Map<string, { listing: DirListing; expiresAt: number }>();
  const dirListingRequests = new Map<string, Promise<DirListing>>();
  const DIR_LISTING_TTL_MS = 30 * 1000;
  function remoteDirectory(hostId: string, dirPath: string, fresh = false): Promise<DirListing> {
    const key = `${hostId}\0${dirPath}`;
    if (!fresh) {
      const cached = dirListings.get(key);
      if (cached !== undefined && cached.expiresAt > Date.now()) return Promise.resolve(cached.listing);
      const pending = dirListingRequests.get(key);
      if (pending !== undefined) return pending;
    }
    const request = bb.sdk.hosts.directory({ hostId, path: dirPath })
      .then((listing) => {
        dirListings.set(key, { listing, expiresAt: Date.now() + DIR_LISTING_TTL_MS });
        for (const [other, entry] of dirListings) if (entry.expiresAt <= Date.now()) dirListings.delete(other);
        return listing;
      })
      .finally(() => {
        if (dirListingRequests.get(key) === request) dirListingRequests.delete(key);
      });
    dirListingRequests.set(key, request);
    return request;
  }

  function dropDirListings(hostId: string, rootPath: string): void {
    const prefix = `${hostId}\0${rootPath}`;
    for (const key of dirListings.keys()) {
      const rest = key.slice(prefix.length);
      if (key.startsWith(prefix) && (rest === "" || rest.startsWith("/") || rest.startsWith("\\"))) dirListings.delete(key);
    }
  }

  // Every open page gets every signal, and a page may hold two subscribers;
  // the sequence number lets each page act on a signal once.
  let changeSequence = 0;
  function publishChange(signal: Omit<FilesChangedSignal, "seq">): void {
    bb.realtime.publish(FILES_CHANGED_CHANNEL, { ...signal, seq: ++changeSequence } satisfies FilesChangedSignal);
  }

  watchHost.experimental_onSignal("changed", ({ hostId, payload }) => {
    const entry = watches.get(hostId, payload.rootPath);
    bb.log.debug(`file watch signal from ${hostId} for ${payload.rootPath}: ${payload.kind} ${payload.paths.map((change) => change.path).join(" ")}`);
    if (payload.kind === "rescan" || payload.paths.some((change) => change.type !== "update")) {
      filesIndexes.delete(payload.rootPath);
      dropDirListings(hostId, payload.rootPath);
    }
    if (entry === undefined) return;
    if (payload.kind === "rescan") {
      publishChange({ root: entry.key, kind: "rescan", changes: [] });
      return;
    }
    if (payload.paths.length > 0) publishChange({ root: entry.key, kind: "changed", changes: payload.paths });
  });
  // The worker took its watches with it. Say so, so open files reload, and
  // start the watches again on the next chance.
  watchHost.experimental_onWorkerExit(({ hostId }) => {
    for (const entry of watches.entriesOn(hostId)) publishChange({ root: entry.key, kind: "rescan", changes: [] });
    watches.markWatching(hostId, []);
    void syncHost(hostId).catch((error: unknown) => bb.log.warn(`file watch restart failed: ${error instanceof Error ? error.message : String(error)}`));
  });
  bb.background.service("watch-reaper", {
    async start(signal) {
      const timer = setInterval(() => void pruneWatches(), WATCH_TTL_MS / 2);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      clearInterval(timer);
      watches.clear();
    },
  });

  /** The host that holds a resolved target's files, or null when none can watch it. */
  async function hostOf(target: { rootPath: string; hostId?: string }): Promise<string | null> {
    return target.hostId ?? primaryHost();
  }

  /**
   * Whether `target` is a directory on the machine this plugin runs on: its
   * host is BB's primary host (or none, for thread storage) and the path
   * exists here. Anything else is read through BB's daemon.
   */
  async function isLocalWorkspace(target: { rootPath: string; hostId?: string }): Promise<boolean> {
    if (target.hostId !== undefined && target.hostId !== (await primaryHost())) return false;
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
      const api = pathApiFor(filePath);
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
    const api = pathApiFor(root);
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
        commits: base.commits.slice(-MAX_COMMITS).reverse().map(({ sha, subject }) => ({ sha, subject: subject.slice(0, MAX_SUBJECT_CHARS) })),
        baseBranch: base.mergeBaseBranch,
        message: base.commits.length > MAX_COMMITS ? `Showing the latest ${MAX_COMMITS} commits` : null,
      };
    },
    async diffList({ threadId, target }) {
      const data = await listDiff(threadId, target);
      const { result, environment } = data;
      return {
        source: data.source, root: environment.path!,
        label: environment.branchName ?? environment.name ?? path.basename(environment.path!),
        baseBranch: data.baseBranch, target: data.target,
        files: result.outcome === "available" ? result.files.slice(0, MAX_DIFF_FILES) : [],
        truncated: result.outcome === "available" && (result.truncated || result.files.length > MAX_DIFF_FILES),
        message: data.message,
      };
    },

    diffRead: readDiff,
    assets: () => assets(),

    async watch({ source, clientId }) {
      // A host file has no workspace root to watch; polling covers it.
      if (source.kind === "host") return { root: null, ttlMs: WATCH_TTL_MS };
      const target = await resolveTarget(source, ".");
      const hostId = await hostOf(target);
      if (hostId === null) return { root: null, ttlMs: WATCH_TTL_MS };
      const entry = watches.register(hostId, target.rootPath, clientId, Date.now() + WATCH_TTL_MS);
      try {
        await syncHost(hostId);
      } catch (error) {
        // A host that is offline or too old to watch: polling carries on.
        bb.log.info(`file watch unavailable on ${hostId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { root: entry.watching ? entry.key : null, ttlMs: WATCH_TTL_MS };
    },

    async unwatch({ source, clientId }) {
      if (source.kind === "host") return null;
      const target = await resolveTarget(source, ".");
      const hostId = await hostOf(target);
      if (hostId === null) return null;
      if (watches.unregister(hostId, target.rootPath, clientId)) await syncHost(hostId).catch(() => undefined);
      return null;
    },

    async previewBase({ path: filePath, source }) {
      const target = await resolveTarget(source, filePath);
      const lease = await bb.sdk.files.createPreview({
        rootPath: target.rootPath,
        ...(target.hostId === undefined ? {} : { hostId: target.hostId }),
        ttlMs: PREVIEW_LEASE_MS,
      });
      return { baseUrl: lease.baseUrl, expiresAtMs: lease.expiresAtMs };
    },

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
        const listing = await listLocalTree(target.rootPath, clean);
        return { root: target.rootPath, ...listing };
      }
      // Another host: the daemon lists one level, the way the local lister
      // does. It sees hidden entries, node_modules, and symlinks, which
      // list_paths dropped; every directory is deferred and lists on expand.
      const hostId = await hostOf(target);
      if (hostId === null) throw new Error("This workspace's host is not available");
      const api = pathApiFor(target.rootPath);
      const listing = await remoteDirectory(
        hostId,
        clean === "" ? target.rootPath : api.join(target.rootPath, clean),
        clean === "",
      );
      const prefix = clean === "" ? "" : `${clean}/`;
      return {
        root: target.rootPath,
        entries: listing.entries.map((entry) => ({
          path: `${prefix}${entry.name}`,
          kind: entry.kind,
          ...(entry.kind === "directory" ? { deferred: true as const } : {}),
        })),
      };
    },

    async search({ source, query, limit = 50 }) {
      const target = await resolveTarget(source, ".");
      const trimmed = query.trim();
      if (trimmed === "") return { matches: [], truncated: false };
      if (await isLocalWorkspace(target)) {
        const files = await localFilesIndex(target.rootPath);
        const scored: { path: string; score: number }[] = [];
        for (const file of files) {
          const score = fuzzyScore(file, trimmed);
          if (score !== null) scored.push({ path: file, score });
        }
        scored.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
        return { matches: scored.slice(0, limit).map(({ path }) => ({ path })), truncated: false };
      }
      // Another host: the daemon fuzzy-searches it and ranks the matches.
      const hostId = await hostOf(target);
      if (hostId === null) throw new Error("This workspace's host is not available");
      const result = await bb.sdk.files.listPaths({
        hostId,
        path: target.rootPath,
        query: trimmed,
        includeFiles: true,
        includeDirectories: false,
        limit,
      });
      return {
        matches: result.paths.map((entry) => ({ path: entry.path.replace(/^\.?\/+/, "") })),
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

  /** Whether a path exists. The SDK has no stat, so a read is the probe; a directory fails with EISDIR. */
  async function exists(absolutePath: string, hostId: { hostId?: string }): Promise<boolean> {
    return bb.sdk.files
      .read({ path: absolutePath, ...hostId })
      .then(() => true)
      .catch((error: unknown) => /EISDIR|is a directory/i.test(error instanceof Error ? error.message : String(error)));
  }
}
