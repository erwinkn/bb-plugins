import type { BbPluginApi } from "@get-bb/plugin-sdk";
export type ThreadEventRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];

export function content(text: string) {
  return { text, truncated: false, totalBytes: Buffer.byteLength(text) };
}
export function eventView(row: ThreadEventRow) {
  const data = row.data as unknown as Record<string, unknown>;
  const item = data.item as Record<string, unknown> | undefined;
  const text = item?.type === "agentMessage" ? item.text : item?.type === "userMessage" && Array.isArray(item.content)
    ? item.content.filter(c => c.type === "text").map(c => c.text).join("\n") : undefined;
  return {
    ...row,
    ...(typeof data.status === "string" ? { status: data.status } : {}),
    ...(typeof data.requestId === "string" ? { requestId: data.requestId } : {}),
    ...(item ? { item: { ...item, ...(typeof text === "string" ? { content: content(text) } : {}) } } : {}),
  };
}
