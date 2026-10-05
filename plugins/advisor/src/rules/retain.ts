// Retained citations (A144 §7, A152 §6). One UTF-8 budget for before, after and
// the requirement quote. Over budget, each side keeps an exact head and tail
// and records the omitted byte count and the full text's hash. "complete" is
// claimed only when nothing was cut.

import { createHash } from "node:crypto";

export const RETAIN_CAP = 8 * 1024;

const utf8 = (s: string) => Buffer.byteLength(s, "utf8");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Head and tail of s cut on character boundaries; returns the omitted byte count. */
export function clipUtf8(s: string, head: number, tail: number): [string, string, number] {
  const b = Buffer.from(s, "utf8");
  if (b.length <= head + tail) return [s, "", 0];
  // Drop a partial character at the cut (Python's errors="ignore" on the edges).
  let end = head;
  while (end > 0 && (b[end]! & 0xc0) === 0x80) end--;
  let start = b.length - tail;
  while (tail > 0 && start < b.length && (b[start]! & 0xc0) === 0x80) start++;
  const h = b.subarray(0, end).toString("utf8");
  const t = tail > 0 ? b.subarray(start).toString("utf8") : "";
  return [h, t, b.length - utf8(h) - utf8(t)];
}

export type RetainedSide = { text: string; sha256: string } | { head: string; tail: string; omittedBytes: number; sha256: string };

export interface Retained {
  status: "complete" | "clipped";
  bytes: number;
  sides: Record<string, RetainedSide>;
  requirementQuote: string;
  requirementOmittedBytes?: number;
}

export function retain(shown: { before?: { text: string }; after?: { text: string }; requirement?: { quote: string } }): Retained {
  const req = shown.requirement?.quote ?? "";
  const sides: Record<string, string> = {};
  for (const s of ["before", "after"] as const) if (shown[s]) sides[s] = shown[s]!.text;
  const total = utf8(req) + Object.values(sides).reduce((n, v) => n + utf8(v), 0);
  if (total <= RETAIN_CAP) {
    return {
      status: "complete",
      bytes: total,
      sides: Object.fromEntries(Object.entries(sides).map(([s, v]) => [s, { text: v, sha256: sha(v) }])),
      requirementQuote: req,
    };
  }
  const [reqKept, , reqLost] = clipUtf8(req, 512, 0);
  const budget = RETAIN_CAP - utf8(reqKept);
  const names = Object.keys(sides);
  // A side under its even share keeps its text whole; the other side reuses the rest.
  const small = new Set(names.filter((s) => utf8(sides[s]!) <= Math.floor(budget / Math.max(1, names.length))));
  const rest = budget - [...small].reduce((n, s) => n + utf8(sides[s]!), 0);
  const share = Math.floor(rest / Math.max(1, names.length - small.size));
  let kept = utf8(reqKept);
  const out: Record<string, RetainedSide> = {};
  for (const s of names) {
    const v = sides[s]!;
    const half = small.has(s) ? utf8(v) : Math.floor(share / 2);
    const [h, t, lost] = clipUtf8(v, half, small.has(s) ? 0 : Math.floor(share / 2));
    out[s] = { head: h, tail: t, omittedBytes: lost, sha256: sha(v) };
    kept += utf8(h) + utf8(t);
  }
  return { status: "clipped", bytes: kept, sides: out, requirementQuote: reqKept, requirementOmittedBytes: reqLost };
}
