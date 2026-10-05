// Turn-end checkpoints of test-scoped paths (A140 §3.3): catching shell edits
// to tests that produce no fileChange event. Never called atomic.

import { hunkKey, type Hunk } from "./diff.js";

export type Coherence = "head-stable" | "head-moved-during-read" | "base-changed" | "unknown-head";

export function coherence(before: string | null, after: string | null, prevHead: string | null): Coherence {
  if (before === null || after === null) return "unknown-head";
  if (before !== after) return "head-moved-during-read";
  if (prevHead !== null && prevHead !== before) return "base-changed";
  return "head-stable";
}

export type Transition =
  | { kind: "snapshot-only"; label: Coherence; removed: null; added: null }
  | { kind: "transition"; label: Coherence; removed: Hunk[]; added: Hunk[] };

/**
 * Between two head-stable checkpoints the unit of comparison is a whole hunk,
 * keyed by (path, old start, old length, full body); removed and added keep
 * their order. "A restored, H weakened" shows as removed [A], added [H].
 */
export function transition(prev: Hunk[] | null, cur: Hunk[], label: Coherence): Transition {
  if (label !== "head-stable" || prev === null) return { kind: "snapshot-only", label, removed: null, added: null };
  const pk = new Set(prev.map(hunkKey));
  const ck = new Set(cur.map(hunkKey));
  return {
    kind: "transition",
    label,
    removed: prev.filter((h) => !ck.has(hunkKey(h))),
    added: cur.filter((h) => !pk.has(hunkKey(h))),
  };
}

/** Minimal glob: `**` spans directories, `*` stays within one segment, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "u");
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => {
    const re = globToRegExp(g);
    return re.test(path) || re.test("x/" + path);
  });
}

export const DEFAULT_TEST_GLOBS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/test_*.py",
  "**/*_test.go",
  "tests/**",
] as const;
