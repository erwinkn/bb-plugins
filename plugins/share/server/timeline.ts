import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { RenderItem } from "../lib/model";

type Threads = BbPluginApi["sdk"]["threads"];
export type TimelineRow = Awaited<ReturnType<Threads["timeline"]>>["rows"][number];
export const MAX_ROWS = 5000;

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
  return { kind: "tool", title, detail, output: "output" in row && typeof row.output === "string" ? row.output : null, status: row.status, at: row.createdAt };
}

export async function readTimeline(threads: Threads, threadId: string, includeTools: boolean): Promise<{ title: string; truncated: boolean; items: RenderItem[] }> {
  const thread = await threads.get({ threadId });
  const rows = new Map<string, TimelineRow>();
  const expanded = new Set<string>();
  const cursors = new Set<string>();
  let truncated = false;
  let cursor: { beforeAnchorId: string; beforeAnchorSeq: string } | undefined;
  // Process newest rows first so the cap preserves the newest conversation.
  async function collect(batch: TimelineRow[]): Promise<void> {
    for (const row of [...batch].sort((a, b) => b.sourceSeqStart - a.sourceSeqStart)) {
      if (rows.has(row.id)) continue;
      if (rows.size >= MAX_ROWS) { truncated = true; return; }
      if (row.kind === "turn") {
        const key = `${row.id}:${row.sourceSeqStart}:${row.sourceSeqEnd}`;
        if (expanded.has(key)) continue;
        expanded.add(key);
        if (expanded.size > MAX_ROWS) { truncated = true; return; }
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
        if (includeTools && "outputPreview" in row && row.outputPreview
          && "output" in row && row.outputPreview.totalChars > row.output.length) truncated = true;
      }
    }
  }
  for (;;) {
    const page = await threads.timeline({ threadId, includeNestedRows: "true", summaryOnly: "false", ...cursor });
    await collect(page.rows);
    if (!page.timelinePage.hasOlderRows) break;
    if (rows.size >= MAX_ROWS) { truncated = true; break; }
    const older = page.timelinePage.olderCursor;
    const key = older && `${older.anchorId}:${older.anchorSeq}`;
    if (!older || !key || cursors.has(key)) { truncated = true; break; }
    cursors.add(key);
    if (cursors.size >= MAX_ROWS) { truncated = true; break; }
    cursor = { beforeAnchorId: older.anchorId, beforeAnchorSeq: String(older.anchorSeq) };
  }
  const items = [...rows.values()].sort((a, b) => a.sourceSeqStart - b.sourceSeqStart)
    .flatMap((row) => { const item = rowToItem(row, includeTools); return item ? [item] : []; });
  return { title: thread.title || thread.titleFallback || "Untitled thread", truncated, items };
}
