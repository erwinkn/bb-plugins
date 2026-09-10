import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { RenderItem } from "../lib/model";

type Threads = BbPluginApi["sdk"]["threads"];
export type TimelineRow = Awaited<ReturnType<Threads["timeline"]>>["rows"][number];
export const MAX_ROWS = 5000;
export const OUTPUT_PREVIEW_OMITTED = "Output omitted: BB stored only a preview of this output.";

function hasIncompleteOutput(row: TimelineRow): boolean {
  // SDK 0.4.47 has only totalChars as a preview marker and no per-row full-output API.
  return row.kind === "work" && "outputPreview" in row && !!row.outputPreview
    && row.outputPreview.totalChars > row.output.length;
}

export function rowToItem(row: TimelineRow, includeTools: boolean): RenderItem | null {
  if (row.kind === "conversation") {
    if (row.role === "user" && row.initiator === "system") return null;
    return { kind: "message", role: row.role, text: row.text, at: row.createdAt };
  }
  if (row.kind !== "work" || !includeTools || row.workKind === "image-view" || row.workKind === "file-change") return null;
  const title = row.workKind === "command" ? row.command
    : row.workKind === "tool" ? row.toolName
    : "cmd" in row && row.cmd ? row.cmd : row.workKind;
  let detail = "cwd" in row ? row.cwd : "path" in row ? row.path : null;
  if (row.workKind === "tool") {
    const value = row.toolArgs?.cwd ?? row.toolArgs?.path;
    detail = typeof value === "string" ? value : null;
  }
  const output = hasIncompleteOutput(row) ? OUTPUT_PREVIEW_OMITTED
    : "output" in row && typeof row.output === "string" ? row.output : null;
  return { kind: "tool", title, detail, output, status: row.status, at: row.createdAt };
}

export async function readTimeline(threads: Threads, threadId: string, includeTools: boolean, maxRows = MAX_ROWS): Promise<{ title: string; truncated: boolean; items: RenderItem[] }> {
  const thread = await threads.get({ threadId });
  const rows = new Map<string, TimelineRow>();
  const expanded = new Set<string>();
  const cursors = new Set<string>();
  let truncated = false;
  let cursor: { beforeAnchorId: string; beforeAnchorSeq: string } | undefined;
  // A turn's start sequence can precede newer children. Flatten every page and
  // expanded turn before ordering and applying the row limit.
  async function collect(batch: TimelineRow[]): Promise<void> {
    for (const row of batch) {
      if (rows.has(row.id)) continue;
      if (row.kind === "turn") {
        const key = `${row.id}:${row.sourceSeqStart}:${row.sourceSeqEnd}`;
        if (expanded.has(key)) continue;
        expanded.add(key);
        if (row.children?.length) await collect(row.children);
        else if (includeTools && row.summaryCount > 0) {
          const details = await threads.timelineTurnSummaryDetails({
            threadId, turnId: row.turnId,
            sourceSeqStart: String(row.sourceSeqStart), sourceSeqEnd: String(row.sourceSeqEnd),
          });
          await collect(details.rows);
        }
      } else {
        rows.set(row.id, row);
        if (includeTools && hasIncompleteOutput(row)) truncated = true;
      }
    }
  }
  for (;;) {
    const page = await threads.timeline({ threadId, includeNestedRows: "true", summaryOnly: "false", ...cursor });
    await collect(page.rows);
    if (!page.timelinePage.hasOlderRows) break;
    const older = page.timelinePage.olderCursor;
    const key = older && `${older.anchorId}:${older.anchorSeq}`;
    if (!older || !key || cursors.has(key)) { truncated = true; break; }
    cursors.add(key);
    cursor = { beforeAnchorId: older.anchorId, beforeAnchorSeq: String(older.anchorSeq) };
  }
  const ordered = [...rows.values()].sort((a, b) => a.sourceSeqStart - b.sourceSeqStart);
  if (ordered.length > maxRows) truncated = true;
  const items = ordered.slice(Math.max(0, ordered.length - maxRows))
    .flatMap((row) => { const item = rowToItem(row, includeTools); return item ? [item] : []; });
  return { title: thread.title || thread.titleFallback || "Untitled thread", truncated, items };
}
