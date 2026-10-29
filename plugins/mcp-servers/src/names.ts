// How an upstream MCP tool is named in BB: `<prefix>_<tool>`, where the
// prefix belongs to the server. BB accepts [a-zA-Z0-9_-]+; the harnesses cap
// the full name at 64 characters, and Claude Code spends 16 of them on its
// `mcp__bb-bridge__` prefix, so a BB name keeps to 48.

import { createHash } from "node:crypto";
import { MAX_PREFIX } from "./schemas";

export { MAX_PREFIX, suggestPrefix } from "./schemas";

export const MAX_TOOL_NAME = 48;
export const PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function validPrefix(prefix: string): boolean {
  return prefix.length <= MAX_PREFIX && PREFIX_PATTERN.test(prefix);
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 6);
}

/**
 * BB names for one server's tools, by upstream name. Characters BB refuses
 * (MCP allows `.` and `/`) become `_`. A name that fits in 48 characters and
 * that no other upstream name shares keeps that plain form. Every other one
 * ends in a hash of its upstream name, so it stays stable while the list
 * changes around it, and is salted further on the off chance it meets a
 * name already taken. Plain names are settled first, so a new tool never
 * renames an existing plain one.
 */
export function bbToolNames(prefix: string, upstream: readonly string[]): Map<string, string> {
  const base = (name: string) => `${prefix}_${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const counts = new Map<string, number>();
  for (const name of upstream) counts.set(base(name), (counts.get(base(name)) ?? 0) + 1);
  const out = new Map<string, string>();
  const taken = new Set<string>();
  const hashed: string[] = [];
  for (const name of new Set(upstream)) {
    const plain = base(name);
    if (plain.length <= MAX_TOOL_NAME && counts.get(plain) === 1) {
      out.set(name, plain);
      taken.add(plain);
    } else {
      hashed.push(name);
    }
  }
  for (const name of [...hashed].sort()) {
    const plain = base(name);
    for (let salt = 0; ; salt += 1) {
      const suffix = `_${shortHash(salt === 0 ? name : `${name}#${salt}`)}`;
      const candidate = `${plain.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`;
      if (!taken.has(candidate)) {
        out.set(name, candidate);
        taken.add(candidate);
        break;
      }
    }
  }
  return out;
}
