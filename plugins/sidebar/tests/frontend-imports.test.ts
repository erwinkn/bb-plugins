import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The Git install builds the frontend with only `@get-bb/plugin-sdk/app`
// available. A runtime import of the root SDK anywhere in the app graph fails
// that build while passing locally, where node_modules has the package.
const ROOT = resolve(import.meta.dirname, "..");
const IMPORT = /^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm;

function resolveLocal(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`])
    if (existsSync(candidate) && !candidate.endsWith(spec)) return candidate;
  return existsSync(base) ? base : null;
}

function runtimeImports(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const source = readFileSync(file, "utf8");
    const packages: string[] = [];
    for (const match of source.matchAll(IMPORT)) {
      const [, typeOnly, spec] = match;
      if (typeOnly) continue;
      const local = resolveLocal(file, spec!);
      if (local) queue.push(local);
      else packages.push(spec!);
    }
    seen.set(file, packages);
  }
  return seen;
}

describe("frontend bundle imports", () => {
  it("never imports the root plugin SDK at runtime", () => {
    const graph = runtimeImports(resolve(ROOT, "app.tsx"));
    const offenders = [...graph]
      .filter(([, packages]) => packages.includes("@get-bb/plugin-sdk"))
      .map(([file]) => file.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
    expect(graph.size).toBeGreaterThan(10);
  });
});
