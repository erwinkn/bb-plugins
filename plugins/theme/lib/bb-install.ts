/**
 * Locate the installed BB app bundle so tests can check the host contracts
 * `themes/color.css` relies on against the app that actually runs here.
 *
 * Order: `BB_APP_DIR`, the `bb` binary on PATH (walk up from its real path to
 * the `bb-app` package), then the global npm root.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export interface BbInstall {
  root: string;
  /** Directory of the frontend chunks (`app/dist/assets`). */
  assetsDir: string;
  version: string;
}

function packageName(dir: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }).name ?? null;
  } catch {
    return null;
  }
}

function fromRoot(root: string): BbInstall | null {
  if (packageName(root) !== "bb-app") return null;
  const assetsDir = join(root, "app", "dist", "assets");
  if (!existsSync(assetsDir)) return null;
  const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  return { root, assetsDir, version };
}

function fromBinary(): BbInstall | null {
  let bin: string;
  try {
    bin = execFileSync("sh", ["-c", "command -v bb"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
  if (bin === "") return null;
  let dir = dirname(realpathSync(bin));
  for (let i = 0; i < 6; i += 1) {
    const found = fromRoot(dir);
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function fromNpmRoot(): BbInstall | null {
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    return fromRoot(join(root, "bb-app"));
  } catch {
    return null;
  }
}

export function findBbInstall(): BbInstall | null {
  const env = process.env.BB_APP_DIR;
  if (env) return fromRoot(env);
  return fromBinary() ?? fromNpmRoot();
}

/** Every frontend chunk of the install, concatenated per file (no .gz/.br). */
export function readBundleFiles(install: BbInstall, extension: ".js" | ".css"): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of readdirSync(install.assetsDir)) {
    if (!name.endsWith(extension)) continue;
    files.set(name, readFileSync(join(install.assetsDir, name), "utf8"));
  }
  return files;
}

/**
 * Code theme names BB ships as lazy chunks (`assets/<name>-<hash>.js`), which
 * is the registry `bb.themes[].codeTheme` names resolve against.
 */
export function shippedCodeThemeNames(install: BbInstall): Set<string> {
  const names = new Set<string>();
  for (const name of readdirSync(install.assetsDir)) {
    const match = /^(.+)-[A-Za-z0-9_-]{8}\.js$/.exec(name);
    if (match) names.add(match[1]);
  }
  return names;
}
