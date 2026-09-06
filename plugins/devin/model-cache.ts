import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { experimental_resolveExecutablePath as resolveExecutablePath } from "@get-bb/plugin-sdk/provider-bridge";

// A catalog younger than FRESH_MS is used as is. Up to MAX_AGE_MS it is still
// used, with a background refresh. Older data blocks for a live lookup.
export const FRESH_MS = 60 * 60 * 1000;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const entrySchema = z.object({ version: z.literal(1), identity: z.string().min(1), fetchedAt: z.number().finite(), catalog: z.unknown() });
export type CatalogEntry = z.infer<typeof entrySchema>;
export interface CatalogStore {
  read(): Promise<CatalogEntry | undefined>;
  write(entry: CatalogEntry): Promise<void>;
}

export function memoryCatalogStore(): CatalogStore {
  let entry: CatalogEntry | undefined;
  return { async read() { return entry; }, async write(next) { entry = next; } };
}

// Shared by every bridge process of this plugin on the machine. A missing,
// oversized, or invalid file is a miss, never an error.
export function fileCatalogStore(dataDir: string): CatalogStore {
  const path = join(dataDir, "model-catalog.json");
  return {
    async read() {
      try {
        if ((await stat(path)).size > MAX_CACHE_BYTES) return undefined;
        return entrySchema.parse(JSON.parse(await readFile(path, "utf8")));
      } catch { return undefined; }
    },
    async write(entry) {
      await mkdir(dataDir, { recursive: true });
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(entry), { mode: 0o600 }); await rename(temp, path); }
      catch (error) { await rm(temp, { force: true }); throw error; }
    },
  };
}

async function readOrgId(path: string): Promise<string | null> {
  try {
    const orgId = (JSON.parse(await readFile(path, "utf8")) as { devin?: { org_id?: unknown } })?.devin?.org_id;
    return typeof orgId === "string" ? orgId : null;
  } catch { return null; }
}

// Fingerprint of the resolved executable and the local sign-in state that the
// CLI documents (`devin auth status` reports the credentials file). Only paths,
// sizes, and modification times are hashed; no credential content is read.
// An unknown identity disables the persistent cache instead of guessing.
export async function devinIdentity(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (env.WINDSURF_API_KEY) return undefined;
  const executable = await resolveExecutablePath(command);
  if (executable === null) return undefined;
  const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  try {
    const [binary, binaryStat, credentialStat, orgId] = await Promise.all([
      realpath(executable), stat(executable), stat(join(dataHome, "devin", "credentials.toml")), readOrgId(join(configHome, "devin", "config.json")),
    ]);
    return createHash("sha256").update(JSON.stringify([binary, binaryStat.size, binaryStat.mtimeMs, credentialStat.size, credentialStat.mtimeMs, orgId])).digest("hex");
  } catch { return undefined; }
}
