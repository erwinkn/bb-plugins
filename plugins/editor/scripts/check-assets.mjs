import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(path.join(tmpdir(), "editor-assets-check-"));

async function files(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await files(path.join(directory, entry.name), relative + "/"));
    else result.push(relative);
  }
  return result.sort();
}

try {
  const build = spawnSync(process.execPath, [path.join(import.meta.dirname, "stage-assets.mjs"), temporary], {
    cwd: pluginRoot,
    stdio: "inherit",
  });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error("Pierre asset build failed");
  const shipped = path.join(pluginRoot, "assets", "pierre");
  const expected = await files(temporary);
  const actual = await files(shipped);
  const changed = new Set([...expected.filter((file) => !actual.includes(file)), ...actual.filter((file) => !expected.includes(file))]);
  for (const file of expected) {
    if (changed.has(file)) continue;
    const [fresh, committed] = await Promise.all([readFile(path.join(temporary, file)), readFile(path.join(shipped, file))]);
    if (!fresh.equals(committed)) changed.add(file);
  }
  if (changed.size > 0) {
    throw new Error(`${changed.size} Pierre assets differ. Run npm run build:pierre and commit assets/pierre/.\n${[...changed].slice(0, 10).join("\n")}`);
  }
  console.log(`Verified ${expected.length} shipped Pierre assets.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
