// Observation (S1): watched-thread events become immutable evidence cards, the
// request table and pause reasons. Only completed items are kept; deltas are
// ignored. Nothing here writes to the watched thread.

import { CLAIM_CAP, boundOutput, claimText, commandCardText } from "../rules/cards.js";
import { matchesAny } from "../rules/checkpoint.js";
import { normPath } from "../rules/diff.js";
import { type EventRow, isInterrupt } from "../rules/events.js";
import { IngestError, editCards, enc } from "../rules/packet.js";
import { Watch } from "../rules/pause.js";
import type { Requests } from "../rules/requests.js";
import type { CardRow, GapLayer, Store, WatchRow } from "../store/store.js";

export interface IngestResult {
  interrupted: boolean;
  turnEnded: boolean;
  acceptedRequest: boolean;
}

/** The persisted pause reasons as the reference Watch, and back. */
export function pauseOf(w: WatchRow): Watch {
  const p = new Watch();
  for (const r of w.state.pause) p.reasons.add(r);
  p.failures = w.state.failures;
  p.epoch = w.epoch;
  return p;
}

export function storePause(w: WatchRow, p: Watch): void {
  w.state.pause = [...p.reasons].sort();
  w.state.failures = p.failures;
}

type NewCard = Omit<CardRow, "reviewed" | "watchId" | "createdAt">;

/**
 * Derive cards from one page of rows. Pure apart from the passed-in sinks, so a
 * page's cards, request rows and cursor commit together in one transaction.
 */
export function deriveFromRows(
  w: WatchRow,
  rows: EventRow[],
  rq: Requests,
  pause: Watch,
  nowMin: number,
  sinks: { card: (c: NewCard) => void; gap: (layer: GapLayer, reason: string, seq: number, detail: string) => void },
): IngestResult {
  const out: IngestResult = { interrupted: false, turnEnded: false, acceptedRequest: false };
  const display = (p: string) => normPath(p, w.rootPath);
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    rq.ingest(row, nowMin);
    pause.observe(row);
    if (row.type === "turn/input/accepted") out.acceptedRequest = true;
    if (row.type === "item/completed") {
      const item = (row.data?.item ?? {}) as Record<string, any>;
      if (item.type === "fileChange") {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        changes.forEach((ch: any, i: number) => {
          const path = String(ch.path ?? "");
          if (item.status !== "completed") {
            sinks.card(noteCard(row.seq, i, path, `edit ${display(path)} reported ${String(item.status)}; not evidence of a change`));
            return;
          }
          if (typeof ch.diff !== "string" || ch.diff === "") {
            sinks.gap("evidence", "edit-diff-absent", row.seq, `${display(path)}: the provider sent no diff for this file change`);
            sinks.card(noteCard(row.seq, i, path, `edit ${display(path)} (${String(ch.kind)}) without a diff from the provider`));
            return;
          }
          try {
            for (const c of editCards(row.seq, i, path, ch.diff)) {
              sinks.card({
                id: c.id,
                seq: row.seq,
                ord: i * 1000 + c.part,
                kind: "edit",
                path,
                text: c.text,
                encBytes: c.encBytes,
                meta: { hunks: c.hunks, inclusion: c.inclusion, changeKind: ch.kind ?? null, movePath: ch.movePath ?? null, itemId: item.id ?? null },
                judge: true,
              });
              w.state.editsSinceCheckpoint[display(path)] = [...(w.state.editsSinceCheckpoint[display(path)] ?? []), c.id];
              if (c.inclusion === "truncated") sinks.gap("evidence", "hunk-truncated", row.seq, `${c.id}: a hunk over 8 KiB was cut; cut lines cannot be cited`);
            }
          } catch (err) {
            if (!(err instanceof IngestError)) throw err;
            sinks.gap("evidence", "ingest-error", row.seq, err.message);
          }
        });
      } else if (item.type === "commandExecution" && (item.status === "completed" || item.status === "failed")) {
        const o = boundOutput(typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "");
        const exit = typeof item.exitCode === "number" ? item.exitCode : null;
        const command = String(item.command ?? "");
        const shown = command.length > 2000 ? `${command.slice(0, 2000)} [${command.length - 2000} characters of the command not shown]` : command;
        const text = commandCardText(shown, exit, typeof item.durationMs === "number" ? item.durationMs : null, o);
        const clipped = enc(text) > 8000 ? text.slice(0, 4000) + "\n[command card cut]" : text;
        sinks.card({
          id: `C:${row.seq}`,
          seq: row.seq,
          ord: 0,
          kind: "command",
          path: null,
          text: clipped,
          encBytes: enc(clipped),
          meta: {
            command: shown,
            exitCode: exit,
            status: item.status,
            outputTruncated: o.outputTruncated || item.truncation?.aggregatedOutput !== undefined,
          },
          judge: true,
        });
      } else if (item.type === "agentMessage" && typeof item.text === "string") {
        w.state.lastAgentMessage = { seq: row.seq, text: item.text };
      }
    } else if (row.type === "turn/completed") {
      const status = String(row.data?.status ?? "unknown");
      const m = w.state.lastAgentMessage;
      if (m) {
        const c = claimText(m.text);
        sinks.card({
          id: `M:${m.seq}`,
          seq: row.seq,
          ord: 0,
          kind: "claim",
          path: null,
          text: c.text,
          encBytes: enc(c.text),
          meta: { messageSeq: m.seq, truncated: c.truncated, cap: CLAIM_CAP },
          judge: true,
        });
        w.state.lastAgentMessage = null;
      }
      const text = `turn ended: ${status}${row.data?.error?.message ? ` (${String(row.data.error.message).slice(0, 300)})` : ""}`;
      sinks.card({ id: `T:${row.seq}`, seq: row.seq, ord: 1, kind: "turn", path: null, text, encBytes: enc(text), meta: { status }, judge: true });
      out.turnEnded = true;
      w.state.checkpointDue = true;
    } else if (row.type === "system/thread/interrupted") {
      const text = `thread interrupted: ${String(row.data?.reason ?? "unknown")}`;
      sinks.card({ id: `T:${row.seq}`, seq: row.seq, ord: 1, kind: "turn", path: null, text, encBytes: enc(text), meta: { status: "interrupted" }, judge: true });
    }
    if (isInterrupt(row)) out.interrupted = true;
  }
  return out;
}

function noteCard(seq: number, i: number, path: string, text: string): NewCard {
  return { id: `N:${seq}:${i}`, seq, ord: i * 1000 + 999, kind: "note", path, text, encBytes: enc(text), meta: {}, judge: false };
}

/** Which unreviewed cards are triggers under the current settings (A140 §5.1). */
export function hasTrigger(
  cards: CardRow[],
  t: { testEdit: boolean; failedCommand: boolean; claim: boolean; turnEnd: boolean },
  testGlobs: readonly string[],
  root: string | null,
): string | null {
  for (const c of cards) {
    if (t.testEdit && (c.kind === "edit" || c.kind === "state") && c.path && matchesAny(normPath(c.path, root), testGlobs)) return `test change ${c.id}`;
    if (t.failedCommand && c.kind === "command" && typeof c.meta.exitCode === "number" && c.meta.exitCode !== 0) return `failed command ${c.id}`;
    if (t.claim && c.kind === "claim") return `completion claim ${c.id}`;
  }
  if (t.turnEnd && cards.some((c) => c.kind === "turn") && cards.some((c) => c.kind !== "turn")) return "turn end with unreviewed evidence";
  return null;
}

export function insertCards(store: Store, watchId: string, cards: NewCard[], now: number): number {
  let n = 0;
  for (const c of cards) if (store.insertCard({ ...c, watchId, createdAt: now })) n++;
  return n;
}
