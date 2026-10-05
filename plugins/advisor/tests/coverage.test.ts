// Port completeness and the public-SDK boundary.
//
// 1. Every one of the 173 accepted A160 reference cases (results.json, copied
//    verbatim with its hash in the manifest) is named by a test here.
// 2. The package imports only the public SDK, zod, Node and its own files.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { fixture } from "./helpers/a160.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TESTS = fileURLToPath(new URL("./", import.meta.url));

/** Test titles a file can produce: string literals, plus `${x}` templates expanded with that file's literals. */
function titles(src: string): Set<string> {
  const lits = [...src.matchAll(/"([^"\\\n]{1,200})"/gu)].map((m) => m[1]!);
  const out = new Set(lits);
  for (const m of src.matchAll(/`([a-z0-9_]*)\$\{(\w+)\}([a-z0-9_]*)`/giu)) {
    for (const l of lits) out.add(`${m[1]}${l}${m[3]}`);
  }
  return out;
}

describe("port completeness", () => {
  it("every accepted A160 case has a named test", () => {
    const names = Object.keys(fixture("results.json").results);
    expect(names).toHaveLength(173);
    const files = readdirSync(TESTS).filter((f) => f.endsWith(".test.ts"));
    const all = new Set<string>();
    for (const f of files) {
      const src = readFileSync(TESTS + f, "utf8");
      for (const call of src.matchAll(/\bit\(\s*([`"][^`"]+[`"])/gu)) {
        const raw = call[1]!;
        if (raw.startsWith('"')) all.add(raw.slice(1, -1));
        else for (const t of titles(src)) if (new RegExp(`^${raw.slice(1, -1).replace(/\$\{\w+\}/gu, ".+")}$`, "u").test(t)) all.add(t);
      }
    }
    const missing = names.filter((n) => !all.has(n));
    expect(missing).toEqual([]);
  });

  it("the reference expectations are the accepted A160 run: 173 cases, 0 failures", () => {
    const r = fixture("results.json");
    expect([r.failures, Object.values<any>(r.results).every((x) => x.pass)]).toEqual([[], true]);
  });
});

describe("public SDK only", () => {
  it("imports nothing private or outside the package", () => {
    const scan = experimental_scanPublicSdkOnly(ROOT, {
      // The public testing entry is allowed in shared test helpers too (tests/helpers/world.ts), and
      // "@/" is the scaffold's tsconfig alias for this package's own vendored components (components.json).
      allow: [/^@get-bb\/plugin-sdk\/testing$/u, /^@\/(components|lib|hooks)\//u, /^react(\/|$)/u, /^react-dom(\/|$)/u, /^@radix-ui\//u, /^@hugeicons\//u, /^class-variance-authority$/u, /^clsx$/u, /^tailwind-merge$/u, /^sonner$/u, /^vitest(\/|$)/u, /^@testing-library\//u],
    });
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
    expect(scan.files.length).toBeGreaterThan(30);
  });
});
