import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { eventEntries, splitEntry, type MemoryMessage } from "./log";
import { senderParts } from "./sender-parts";
import type { ListEvents } from "./ingest";

const PAGE = 24_000;
export interface EvidenceDeps {
  list: ListEvents;
  attachment?: (threadId: string, path: string) => Promise<{bytes: Uint8Array; mimeType: string}>;
}
/** UTF-8 pages have byte offsets, always at character boundaries. */
export function evidencePage(text: string, offset: number) {
  const bytes = Buffer.from(text);
  if (offset > bytes.length || (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80)) throw new Error("offset must be a UTF-8 character boundary within the source");
  let end = Math.min(bytes.length, offset + PAGE);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return {text: bytes.subarray(offset, end).toString("utf8"), next: end < bytes.length ? end : null, total: bytes.length};
}

/** Recover only the selected semantic entry, never a whole event envelope or reasoning. */
export async function originalEvidence(deps: EvidenceDeps, m: MemoryMessage, offset = 0, attachment?: number): Promise<PluginAgentToolResult> {
  const source = `${m.threadId ?? "import"}:${m.seq ?? "unknown"}`;
  let text = m.text;
  let availability = "saved copy only; canonical source unavailable";
  let attachments: Array<{path?: string; url?: string; type?: string; data?: string; mimeType?: string}> = [];
  if (m.threadId && m.seq !== null) {
    try {
      const [row] = await deps.list({threadId: m.threadId, types: ["client/turn/requested","item/completed","turn/completed","provider/unhandled"], order: "asc", afterSeq: String(m.seq-1), limit: "1"});
      if (row?.seq === m.seq) {
        const facts = {spawnedByPlugin: m.kind === "note", sender: () => "thread"};
        const entries = eventEntries(row, m.threadId, facts);
        // New logs select by durable source ordinal. Legacy rows compare normalized unsplit
        // content so a mutable sender label cannot shift the 30,000-character chunk boundary.
        const sameKind = entries.filter(e => e.kind === m.kind);
        const body = (text: string) => m.kind === "work" ? text.replace(/^\[[^\]]+\]\s*/, "") : text;
        const matches = sameKind.filter(e => splitEntry(e).some(p => p.text === m.text) || body(e.text).includes(body(m.text)));
        const selected = m.sourcePart != null
          ? entries.find(e => e.sourcePart === m.sourcePart && e.kind === m.kind)
          : matches.length === 1 ? matches[0] : sameKind.length === 1 ? sameKind[0] : undefined;
        if (selected) {
          const index = entries.indexOf(selected);
          text = eventEntries(row, m.threadId, facts, true)[index]!.text;
          availability = "canonical semantic message";
          const item = row.data?.item;
          if (item?.truncation && m.kind === "echo") availability = "canonical retained output; source retention may have removed the middle (see truncation marker)";
          if (row.type === "client/turn/requested") {
            const parts = senderParts(row.data);
            const input = m.kind === "work" && parts.length > 1 ? parts[index]?.input : row.data?.input;
            attachments = (input ?? []).filter((c: {type: string}) => ["localImage","localFile","image"].includes(c.type));
          }
          if (m.kind === "echo" && item?.type === "toolCall") {
            let result = item.result;
            if (typeof result === "string") { try {result = JSON.parse(result);} catch { /* plain text output */ } }
            attachments = (result?.content ?? []).filter((c: {type: string}) => c.type === "image");
          }
        } else availability = "saved copy only; canonical semantic message could not be matched";
      }
    } catch (error) {
      availability = `saved copy only; canonical read failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const page = evidencePage(text, attachment === undefined ? offset : 0);
  const notices = attachments.map((a,i) => `${i}: ${a.path ?? (a.url?.startsWith("data:") ? "inline image" : a.url) ?? a.mimeType ?? a.type}`);
  const pageOffset = attachment === undefined ? offset : 0;
  const header = `source ${source}; ${availability}; kind ${m.kind}; bytes ${pageOffset}..${pageOffset+Buffer.byteLength(page.text)} of ${page.total}; next offset ${page.next ?? "none"}`;
  const content: Array<{type:"text"; text:string} | {type:"image"; data:string; mimeType:string}> = [{type:"text",text:`${header}\n${page.text}${notices.length ? `\nAttachments (retrieve with attachment index):\n${notices.join("\n")}` : ""}`}];
  if (attachment !== undefined) {
    const a = attachments[attachment];
    if (!a) throw new Error(`No attachment ${attachment} at source ${source}`);
    if (a.type === "image" && a.url?.startsWith("data:image/")) {
      const match = /^data:(image\/[^;,]+);base64,(.*)$/s.exec(a.url);
      if (!match) throw new Error("Unsupported image data URL encoding");
      content.push({type:"image",mimeType:match[1]!,data:match[2]!});
    } else if (a.type === "image" && a.data && a.mimeType) content.push({type:"image",data:a.data,mimeType:a.mimeType});
    else if (a.path && deps.attachment && m.threadId) {
      const file = await deps.attachment(m.threadId, a.path);
      if (file.mimeType.startsWith("image/")) content.push({type:"image",data:Buffer.from(file.bytes).toString("base64"),mimeType:file.mimeType});
      else if (file.mimeType.startsWith("text/") || /json|xml/.test(file.mimeType)) {
        const part = evidencePage(Buffer.from(file.bytes).toString("utf8"), offset);
        content.push({type:"text",text:`attachment ${attachment}; next offset ${part.next ?? "none"}\n${part.text}`});
      } else content.push({type:"text",text:`Binary attachment ${a.path} (${file.mimeType}, ${file.bytes.length} bytes). This SDK supports tool text and images only. Retrieve the file using its source path.`});
    } else content.push({type:"text",text:`Attachment unavailable through this SDK: ${a.path ?? a.url ?? a.type}`});
  }
  return {content};
}
