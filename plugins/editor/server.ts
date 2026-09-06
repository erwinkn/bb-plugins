import path from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const MAX_EDITABLE_BYTES = 8 * 1024 * 1024;
const MAX_TREE_ENTRIES = 10_000;
const ASSET_LEASE_TTL_MS = 60 * 60 * 1000;
const ASSET_LEASE_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const PACKAGE_NAME = "bb-plugin-erwin-editor";

export const sourceSchema = z
  .object({
    kind: z.enum(["workspace", "host", "thread-storage"]),
    threadId: z.string().nullable(),
    environmentId: z.string().nullable(),
    projectId: z.string().nullable(),
    experimental_hostId: z.string().optional(),
  })
  .strict();

export type FileSource = z.infer<typeof sourceSchema>;

const fileSchema = z.object({ path: z.string().min(1), source: sourceSchema }).strict();

export const rpcContract = defineRpcContract({
  assets: {
    input: z.null(),
    output: z.object({ baseUrl: z.string(), expiresAtMs: z.number() }),
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
  tree: {
    input: z.object({ source: sourceSchema }).strict(),
    output: z.object({
      root: z.string(),
      entries: z.array(z.object({ path: z.string(), kind: z.enum(["file", "directory"]) })),
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
      z.object({ key: z.literal("minimap"), value: z.boolean() }),
      z.object({ key: z.literal("lineNumbers"), value: z.boolean() }),
      z.object({ key: z.literal("formatOnSave"), value: z.boolean() }),
      z.object({ key: z.literal("autoSave"), value: z.enum(["off", "onBlur", "afterDelay"]) }),
      z.object({ key: z.literal("fileTreeSide"), value: z.enum(["left", "right"]) }),
    ]),
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
  const entryDir = path.join(pluginRoot, "monaco-bundle");
  if (!existsSync(entryDir)) return false;
  const inputs = [
    path.join(pluginRoot, "scripts", "stage-assets.mjs"),
    path.join(pluginRoot, "package.json"),
    ...readdirSync(entryDir).map((name) => path.join(entryDir, name)),
  ];
  return inputs.some((input) => existsSync(input) && statSync(input).mtimeMs > builtAtMs);
}

async function ensureBundleDir(log: (message: string) => void): Promise<string> {
  const pluginRoot = findPluginRoot(path.dirname(fileURLToPath(import.meta.url)));
  const bundleDir = path.join(pluginRoot, "dist", "monaco");
  const built = existsSync(path.join(bundleDir, "editor.js"));
  if (built && !isBundleStale(pluginRoot, bundleDir)) return bundleDir;
  log(built ? "editor bundle is older than its sources; rebuilding it" : "editor bundle missing; building it");
  const script = path.join(pluginRoot, "scripts", "stage-assets.mjs");
  try {
    await import(`${new URL(`file://${script}`).href}?t=${Date.now()}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not build the editor bundle (${reason}); run \`npm run build:monaco\` in ${pluginRoot}`,
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
    minimap: { type: "boolean", label: "Show minimap", default: false },
    autoSave: {
      type: "select",
      label: "Auto save",
      options: ["off", "onBlur", "afterDelay"],
      default: "off",
    },
    formatOnSave: { type: "boolean", label: "Format on save (languages with a formatter)", default: false },
    fileTreeSide: {
      type: "select",
      label: "File tree side",
      options: ["left", "right"],
      default: "right",
    },
    typescriptDiagnostics: {
      type: "select",
      label: "TypeScript diagnostics (the checker sees only the open file)",
      options: ["off", "syntax", "semantic"],
      default: "syntax",
    },
  });

  let assetLease: { baseUrl: string; expiresAtMs: number } | null = null;

  async function assets() {
    const now = Date.now();
    if (assetLease === null || assetLease.expiresAtMs - now < ASSET_LEASE_REFRESH_MARGIN_MS) {
      const bundleDir = await ensureBundleDir((message) => bb.log.info(message));
      assetLease = await bb.sdk.files.createPreview({ rootPath: bundleDir, ttlMs: ASSET_LEASE_TTL_MS });
    }
    return assetLease;
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

  bb.rpc.register(rpcContract, {
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

    async tree({ source }) {
      const target = await resolveTarget(source, ".");
      const result = await bb.sdk.files.listPaths({
        path: target.rootPath,
        includeFiles: true,
        includeDirectories: true,
        limit: MAX_TREE_ENTRIES,
        ...(target.hostId !== undefined ? { hostId: target.hostId } : {}),
      });
      return {
        root: target.rootPath,
        entries: result.paths.map((entry) => ({ path: entry.path, kind: entry.kind })),
        truncated: result.truncated,
      };
    },

    async write({ path: filePath, source, content, expectedSha256 }) {
      const target = await resolveTarget(source, filePath);
      const result = await bb.sdk.files.write({ ...target, content, contentEncoding: "utf8", expectedSha256 });
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
  });

  /** Whether a file or directory exists; a directory reads with an error too, so mkdir stays idempotent. */
  async function exists(absolutePath: string, hostId: { hostId?: string }): Promise<boolean> {
    return bb.sdk.files
      .read({ path: absolutePath, ...hostId })
      .then(() => true)
      .catch((error: unknown) => /EISDIR|is a directory/i.test(error instanceof Error ? error.message : String(error)));
  }
}
