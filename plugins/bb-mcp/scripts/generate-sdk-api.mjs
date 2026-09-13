#!/usr/bin/env node
// Regenerates sdk-api.ts from @get-bb/plugin-sdk's bundled declarations:
// every method the sandbox exposes (SDK_PATHS is derived from it), plus the
// paths whose args accept `signal`. Run `npm run sdk-api` after `bb plugin
// types` bumps the SDK; tests/codemode.test.ts fails when the file drifts.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const sdkDir = new URL("node_modules/@get-bb/plugin-sdk/", root);

// threads.getPluginMetadata/updatePluginMetadata are bound to this plugin's
// namespace through PluginBbSdk (bb.sdk): pluginId is optional there and
// defaults to "bb-mcp". The BbSdk declaration says it is required.
const OVERRIDES = {
  "threads.getPluginMetadata": "threads.getPluginMetadata(args: { threadId: string; pluginId?: string }): Promise<ThreadPluginMetadataResult>;",
  "threads.updatePluginMetadata": "threads.updatePluginMetadata(args: { threadId: string; pluginId?: string; set?: JsonObject; remove?: string[] }): Promise<ThreadPluginMetadataResult>;",
};

export function parseSdk(dts) {
  // Interface bodies keyed by name, plus the `extends` clause, and type
  // aliases keyed by name with their right-hand side.
  const bodies = new Map();
  const extendsOf = new Map();
  for (const m of dts.matchAll(/^(?:export )?interface (\w+)((?:\s+extends\s+[^{]+)?)\s*\{([\s\S]*?)\n\}/gm)) {
    bodies.set(m[1], m[3]);
    extendsOf.set(m[1], m[2]);
  }
  const aliases = new Map();
  for (const m of dts.matchAll(/^(?:export )?type (\w+)(?:<[^>]*>)? = /gm)) {
    let i = m.index + m[0].length, depth = 0;
    for (; i < dts.length; i++) {
      const c = dts[i];
      if (c === "(" || c === "{" || c === "<" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === ">" || c === "]") depth--;
      else if (c === ";" && depth === 0) break;
    }
    aliases.set(m[1], dts.slice(m.index + m[0].length, i));
  }
  // `signal?` reaches a method's args through the args interface itself, an
  // `extends` chain, or an intersection alias (`Query & { signal?: ... }`).
  // Utility wrappers (Omit/Partial/...) keep the key unless they remove it,
  // which the SDK never does for signal.
  const UTILITY = new Set(["Omit", "Partial", "Pick", "Required", "Readonly", "Exclude", "Extract", "NonNullable", "Promise", "Array", "Record"]);
  const hasSignal = (name, seen = new Set()) => {
    if (seen.has(name)) return false;
    seen.add(name);
    if (bodies.has(name)) {
      if (/\bsignal\?:/.test(bodies.get(name))) return true;
      return [...(extendsOf.get(name) ?? "").matchAll(/\b([A-Z]\w*)\b/g)].some(x => !UTILITY.has(x[1]) && hasSignal(x[1], seen));
    }
    if (aliases.has(name)) {
      const rhs = aliases.get(name);
      if (/\bsignal\?:/.test(rhs)) return true;
      // Only recurse on referenced names outside object literals: a property
      // typed with a signal-bearing type does not lift `signal` to the top.
      const outside = rhs.replace(/\{[^{}]*\}/g, "");
      return [...outside.matchAll(/\b([A-Z]\w*)\b/g)].some(x => !UTILITY.has(x[1]) && hasSignal(x[1], seen));
    }
    return false;
  };
  const methods = [];
  const signalPaths = new Set();
  const seen = new Set();
  const walk = (prefix, body) => {
    for (const m of body.matchAll(/^\s{4}(\w+): (\w+Area);/gm)) walk(prefix + m[1] + ".", bodies.get(m[2]) ?? "");
    for (const m of body.matchAll(/^\s{4}(\w+)(?:<[^>\n]*>)?\(/gm)) {
      const name = m[1];
      // subscribe returns a live unsubscribe handle and cannot cross the sandbox bridge.
      if (name === "subscribe") continue;
      const path = prefix + name;
      // Scan the args and return type with bracket balancing: return types
      // may be multi-line object literals (Promise<{ ok: true; }>).
      let i = m.index + m[0].length, depth = 1, argsEnd = -1;
      for (; i < body.length; i++) {
        const c = body[i];
        if (c === "(" || c === "{" || c === "<" || c === "[") depth++;
        else if (c === ")" || c === "}" || c === ">" || c === "]") { depth--; if (depth === 0) { argsEnd = i; break; } }
      }
      if (argsEnd < 0) throw new Error(`Unbalanced args for ${path}`);
      const argsText = body.slice(m.index + m[0].length, argsEnd);
      let j = argsEnd + 1;
      while (/\s|:/.test(body[j])) j++;
      depth = 0; let retEnd = -1;
      for (let k = j; k < body.length; k++) {
        const c = body[k];
        if (c === "(" || c === "{" || c === "<" || c === "[") depth++;
        else if (c === ")" || c === "}" || c === ">" || c === "]") depth--;
        else if (c === ";" && depth === 0) { retEnd = k; break; }
      }
      if (retEnd < 0) throw new Error(`Unterminated return type for ${path}`);
      const returnText = body.slice(j, retEnd);
      const norm = s => s.replace(/\s+/g, " ").replace(/; \}/g, " }").trim();
      if (OVERRIDES[path] && seen.has(path)) continue;
      methods.push(OVERRIDES[path] ?? `${path}(${norm(argsText)}): ${norm(returnText)};`);
      seen.add(path);
      if (/\bsignal\?/.test(argsText)) { signalPaths.add(path); continue; }
      const typeName = argsText.match(/\w+\??\s*:\s*(\w+)/)?.[1];
      if (typeName && hasSignal(typeName)) signalPaths.add(path);
    }
  };
  for (const m of (bodies.get("BbSdkAreas") ?? "").matchAll(/^\s{4}(\w+): (\w+Area);/gm)) walk(m[1] + ".", bodies.get(m[2]) ?? "");
  for (const m of (bodies.get("BbSdk") ?? "").matchAll(/^\s{4}(\w+): (\w+Area);/gm)) walk(m[1] + ".", bodies.get(m[2]) ?? "");
  const paths = [...new Set(methods.map(l => l.match(/^([\w.]+)\(/)[1]))];
  return { methods, paths, signalPaths: [...signalPaths].sort() };
}

export function render() {
  const version = JSON.parse(readFileSync(new URL("package.json", sdkDir), "utf8")).version;
  const dts = readFileSync(new URL("bundled-types/bb-plugin-sdk.d.ts", sdkDir), "utf8");
  const { methods, signalPaths } = parseSdk(dts);
  const content = `// Generated by scripts/generate-sdk-api.mjs from @get-bb/plugin-sdk ${version}.
// Do not edit by hand: run \`npm run sdk-api\` after \`bb plugin types\`.
export const SDK_VERSION = ${JSON.stringify(version)};

// Every SDK method the sandbox exposes, one declaration per line. SDK_PATHS
// in codemode.ts is derived from it and the tool descriptions embed it.
export const SDK_METHODS = \`
${methods.join("\n").replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\`;

// Methods whose args declare \`signal?: AbortSignal\`. Injecting it anywhere
// else fails strict arg validation.
export const SIGNAL_PATHS: readonly string[] = ${JSON.stringify(signalPaths, null, 2).replace(/\n/g, "\n")};
`;
  return content;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = new URL("sdk-api.ts", root);
  const next = render();
  const check = process.argv.includes("--check");
  let current = "";
  try { current = readFileSync(target, "utf8"); } catch { /* first generation */ }
  if (check) {
    if (current !== next) { console.error("sdk-api.ts is stale: run `npm run sdk-api`."); process.exit(1); }
    console.log("sdk-api.ts is current.");
  } else {
    writeFileSync(target, next);
    console.log(`Wrote ${fileURLToPath(target)} (${next.split("\n").length} lines).`);
  }
}
