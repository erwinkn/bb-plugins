import type { BbPluginApi } from "@get-bb/plugin-sdk";
export type ThreadEventRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];

export function clip(text: string, limit = 4000) {
  const bytes = Buffer.from(text);
  return { text: bytes.length <= limit ? text : bytes.subarray(0, limit).toString("utf8"), truncated: bytes.length > limit, totalBytes: bytes.length };
}
export function eventView(row: ThreadEventRow) {
  const data = row.data as unknown as Record<string, unknown>;
  const item = data.item as Record<string, unknown> | undefined;
  const text = item?.type === "agentMessage" ? item.text : item?.type === "userMessage" && Array.isArray(item.content)
    ? item.content.filter(c => c.type === "text").map(c => c.text).join("\n") : undefined;
  return {
    id: row.id, seq: row.seq, createdAt: row.createdAt, type: row.type, scope: row.scope,
    ...(typeof data.status === "string" ? { status: data.status } : {}),
    ...(typeof data.requestId === "string" ? { requestId: data.requestId } : {}),
    ...(item ? { item: { id: item.id, type: item.type, ...(typeof item.name === "string" ? { name: item.name } : {}), ...(typeof text === "string" ? { content: clip(text) } : {}) } } : {}),
  };
}
