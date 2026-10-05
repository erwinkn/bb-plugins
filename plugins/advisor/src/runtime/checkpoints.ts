// Turn-end checkpoints of test-scoped paths (A140 §3.3). Agents often edit
// files through the shell (sed, heredocs, scripts), which produces no
// fileChange event. A checkpoint reads HEAD, the uncommitted listing, the
// HEAD-relative patches of up to N test paths, then HEAD again at least 3 s
// later. It is never called atomic: the coherence label says what holds.

import { coherence, matchesAny, transition, type Coherence } from "../rules/checkpoint.js";
import { normPath, parseUnified, type Hunk } from "../rules/diff.js";
import { CARD_ENC_CAP, IngestError, enc, splitHunks } from "../rules/packet.js";
import type { AdvisorHost } from "./host.js";
import { readSignal } from "./host.js";
import type { CardRow, CheckpointSnapshot, GapLayer, Store, WatchRow } from "../store/store.js";

export const STATUS_GAP_MS = 3000;
const PATCH_KEEP = 64 * 1024; // per path; a larger patch is stored as unreadable

type NewCard = Omit<CardRow, "reviewed" | "watchId" | "createdAt">;

export interface CheckpointDeps {
  host: AdvisorHost;
  store: Store;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface CheckpointResult {
  label: Coherence | "unavailable";
  cards: number;
  shellChanged: string[];
  /** The state cards this checkpoint inserted. */
  added?: NewCard[];
}

function headOf(r: Awaited<ReturnType<AdvisorHost["envStatus"]>> | null): string | null {
  if (!r || r.outcome !== "available") return null;
  const c = r.workspace.checkout;
  return c.kind === "branch" || c.kind === "detached" ? c.headSha : null;
}

export async function runCheckpoint(
  d: CheckpointDeps,
  w: WatchRow,
  opts: { testGlobs: readonly string[]; maxPaths: number; atSeq: number; baseline: boolean },
  signal: AbortSignal,
): Promise<CheckpointResult> {
  const gap = (layer: GapLayer, reason: string, detail: string) => d.store.addGap(w.id, layer, reason, opts.atSeq, opts.atSeq, detail, d.now());
  if (!w.environmentId) {
    gap("evidence", "checkpoint-unavailable", "the watched thread has no environment");
    return { label: "unavailable", cards: 0, shellChanged: [] };
  }
  const env = w.environmentId;
  const safe = async <T>(f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f();
    } catch {
      return null;
    }
  };
  const s1 = await safe(() => d.host.envStatus(env, readSignal(signal)));
  const startedAt = d.now();
  const files = await safe(() => d.host.envDiffFiles(env, readSignal(signal)));
  if (!files || files.outcome !== "available") {
    const why = !files ? "listing read failed" : files.outcome === "not_applicable" ? "not a git environment" : files.failure.message;
    gap("evidence", "checkpoint-unavailable", why);
    return { label: "unavailable", cards: 0, shellChanged: [] };
  }
  if (files.truncated) gap("evidence", "checkpoint-listing-truncated", "the uncommitted listing was truncated; some test paths were not seen");
  const rel = (p: string) => normPath(p, w.rootPath);
  const listed = files.files.filter((f) => !f.binary && matchesAny(rel(f.path), opts.testGlobs)).map((f) => f.path);
  const nonTest = files.files.length - listed.length;
  const prev = d.store.getCheckpoint(w.id);
  // Read the previously read paths that are no longer listed too: their patch is now empty (restored or committed).
  const vanished = prev ? Object.keys(prev.read).filter((p) => !listed.includes(p)) : [];
  const ordered = [...listed].sort();
  const start = ordered.length > 0 ? w.state.checkpointCursor % ordered.length : 0;
  const rotated = [...ordered.slice(start), ...ordered.slice(0, start)];
  const toRead = rotated.slice(0, opts.maxPaths);
  w.state.checkpointCursor = ordered.length > 0 ? (start + toRead.length) % ordered.length : 0;
  if (rotated.length > toRead.length) gap("evidence", "checkpoint-path-cap", `${rotated.length - toRead.length} changed test paths not read this time (round-robin)`);
  const patches: Record<string, string> = {};
  const unreadable: string[] = [];
  if (toRead.length > 0) {
    const res = await safe(() => d.host.envDiffPatch(env, toRead, readSignal(signal)));
    if (!res || res.outcome !== "available") {
      gap("evidence", "checkpoint-patch-failed", !res ? "patch read failed" : res.outcome);
      return { label: "unavailable", cards: 0, shellChanged: [] };
    }
    for (const p of res.patches) {
      if (p.truncated || Buffer.byteLength(p.patch) > PATCH_KEEP) unreadable.push(p.path);
      else patches[p.path] = p.patch;
    }
  }
  const wait = STATUS_GAP_MS - (d.now() - startedAt);
  if (wait > 0) await d.sleep(wait, signal);
  const s2 = await safe(() => d.host.envStatus(env, readSignal(signal)));
  const h1 = headOf(s1);
  const h2 = headOf(s2);
  const label = coherence(h1, h2, prev?.head ?? null);
  const n = (prev?.n ?? 0) + 1;
  const snap: CheckpointSnapshot = { n, head: h1 === h2 ? h1 : null, at: d.now(), listed, read: patches, unreadable };
  if (nonTest > 0) d.store.addGap(w.id, "evidence", "non-test-paths-changed", opts.atSeq, opts.atSeq, `${nonTest} non-test paths changed; not snapshotted`, d.now());
  if (opts.baseline || !prev) {
    d.store.setCheckpoint(w.id, snap);
    w.state.editsSinceCheckpoint = {};
    return { label, cards: 0, shellChanged: [] };
  }
  if (label !== "head-stable") {
    const detail =
      label === "base-changed"
        ? `HEAD moved ${prev.head ?? "?"}→${h1 ?? "?"}; committed content not reviewed`
        : label === "head-moved-during-read"
          ? `HEAD moved during the read (${h1 ?? "?"}→${h2 ?? "?"}); no transition computed`
          : "HEAD unknown; no transition computed";
    gap("evidence", `checkpoint-${label}`, detail);
    d.store.setCheckpoint(w.id, snap);
    w.state.editsSinceCheckpoint = {};
    return { label, cards: 0, shellChanged: [] };
  }
  const newCards: NewCard[] = [];
  const shellChanged: string[] = [];
  // Without the root, edit events (absolute paths) cannot be matched to these relative paths: attribution is unknown.
  const rootKnown = w.rootPath !== null;
  const paths = [...new Set([...Object.keys(patches), ...vanished])].sort();
  paths.forEach((path, i) => {
    let before: Hunk[] | null;
    if (prev.unreadable.includes(path)) before = null;
    else if (path in prev.read) before = parseUnified(path, prev.read[path]!);
    else if (prev.listed.includes(path)) before = null; // listed then, but not read: unknown
    else before = []; // clean against HEAD at the previous checkpoint
    const cur = path in patches ? parseUnified(path, patches[path]!) : [];
    if (before === null) {
      gap("evidence", "checkpoint-path-unknown", `${rel(path)}: no earlier snapshot; no transition`);
      return;
    }
    const t = transition(before, cur, label);
    if (t.kind !== "transition" || (t.removed.length === 0 && t.added.length === 0)) return;
    const observed = w.state.editsSinceCheckpoint[rel(path)] ?? [];
    if (rootKnown && observed.length === 0) shellChanged.push(rel(path));
    for (const [side, hunks] of [
      ["r", t.removed],
      ["a", t.added],
    ] as const) {
      if (hunks.length === 0) continue;
      const shownEdits = observed.length > 5 ? `${observed.slice(0, 5).join(", ")}, +${observed.length - 5} more` : observed.join(", ");
      const head =
        side === "r"
          ? "# HEAD-relative hunks present at the previous checkpoint and gone now (restored, changed or committed)"
          : `# HEAD-relative hunks new since the previous checkpoint; writer unknown; observed edit events: ${
              !rootKnown ? "unknown (the environment root path was not read, so edit paths cannot be matched)" : observed.length > 0 ? shownEdits : "none (shell or another writer)"
            }`;
      try {
        for (const c of splitHunks(`S:${n}:${i}${side}`, opts.atSeq, path, hunks, CARD_ENC_CAP - enc(head) - 2)) {
          const text = `${head}\n${c.text}`;
          newCards.push({
            id: c.id,
            seq: opts.atSeq,
            ord: 10_000 + i * 100 + (side === "a" ? 50 : 0) + c.part,
            kind: "state",
            path,
            text,
            encBytes: enc(text),
            meta: { hunks: c.hunks, inclusion: c.inclusion, checkpoint: n, side: side === "r" ? "removed" : "added", observedEdits: rootKnown ? observed : null, writer: "unknown", header: 1 },
            judge: true,
          });
        }
      } catch (err) {
        if (!(err instanceof IngestError)) throw err;
        gap("evidence", "ingest-error", err.message);
      }
    }
  });
  const added = newCards.filter((c) => d.store.insertCard({ ...c, watchId: w.id, createdAt: d.now() }));
  d.store.setCheckpoint(w.id, snap);
  w.state.editsSinceCheckpoint = {};
  return { label, cards: added.length, shellChanged, added };
}
