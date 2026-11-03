import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { TOOL_USES, USES, eventEntries, splitEntry, type EventRow, type MemoryMessage } from "./log";
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
/**
 * `split`: the message was logged before W571, when a tool use was a tool row for its call and an
 * echo row for its result. The caller reads that from the log (an echo row, or a tool row whose
 * event goes on with an echo row), never from the text, which source retention can change.
 */
type Attachment = {path?: string; url?: string; type?: string; data?: string; mimeType?: string};
const RETAINED = "canonical retained output; source retention may have removed the middle (see truncation marker)";
/** A tool call's result images. */
function resultImages(item: Record<string, any> | undefined): Attachment[] {
  if (item?.type !== "toolCall") return [];
  let result = item.result;
  if (typeof result === "string") { try {result = JSON.parse(result);} catch { /* plain text output */ } }
  return (result?.content ?? []).filter((c: {type: string}) => c.type === "image");
}

/**
 * W571: a group's uses, each in full, read from its events seq through endSeq. Every tool entry
 * in that range belongs to the group: a run's uses are logged in event order, and any other entry
 * would have closed it. Reads stop before endSeq + 1 (exclusive): a large event after the group
 * must not push a page past BB's response limit. Inside the range, events whose payloads
 * (screenshots) the logged text leaves out can pass that limit together: a page that fails is
 * read again at half the size, down to one event, whose own failure is the zoom's.
 */
async function groupSource(deps: EvidenceDeps, m: MemoryMessage & {threadId: string; seq: number; endSeq: number}) {
  const uses: string[] = [];
  const seqs: number[] = [];
  const attachments: Attachment[] = [];
  let truncated = false;
  const facts = {spawnedByPlugin: false, sender: () => "thread"};
  let limit = 100;
  for (let after = m.seq - 1; after < m.endSeq;) {
    let page: EventRow[];
    try {
      page = await deps.list({threadId: m.threadId, types: ["item/completed"], order: "asc", afterSeq: String(after), beforeSeq: String(m.endSeq + 1), limit: String(limit)});
    } catch (error) {
      if (limit === 1) throw error;
      limit = Math.ceil(limit / 2);
      continue;
    }
    const rows = page.filter(r => r.seq > after).sort((a, b) => a.seq - b.seq);
    for (const row of rows) {
      if (row.seq > m.endSeq) break;
      const tools = eventEntries(row, m.threadId, facts, {original: true}).filter(e => e.kind === "tool");
      if (!tools.length) continue;
      uses.push(...tools.map(e => e.text));
      seqs.push(row.seq);
      if (row.data?.item?.truncation) truncated = true;
      attachments.push(...resultImages(row.data?.item));
    }
    if (rows.length < limit) break;
    after = rows.at(-1)!.seq;
  }
  // The ends alone miss a use gone from the middle (review r2 P2); rows logged without a count
  // are checked by their ends.
  if (seqs[0] !== m.seq || seqs.at(-1) !== m.endSeq || (m.uses != null && uses.length !== m.uses)) return null;
  return {text: uses.join(USES), availability: truncated ? RETAINED : "canonical semantic message", attachments};
}

export async function originalEvidence(deps: EvidenceDeps, m: MemoryMessage, offset = 0, attachment?: number, split = false): Promise<PluginAgentToolResult> {
  const group = m.endSeq != null && m.endSeq !== m.seq;
  const source = `${m.threadId ?? "import"}:${m.seq ?? "unknown"}${group ? `..${m.endSeq}` : ""}`;
  let text = m.text;
  let availability = "saved copy only; canonical source unavailable";
  let attachments: Attachment[] = [];
  if (group && m.threadId && m.seq !== null) {
    try {
      const found = await groupSource(deps, {...m, threadId: m.threadId, seq: m.seq, endSeq: m.endSeq!});
      if (found) ({text, availability, attachments} = found);
      else availability = "saved copy only; canonical tool uses could not be matched";
    } catch (error) {
      availability = `saved copy only; canonical read failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else if (m.threadId && m.seq !== null) {
    try {
      const [row] = await deps.list({threadId: m.threadId, types: ["client/turn/requested","item/completed","turn/completed","provider/unhandled"], order: "asc", afterSeq: String(m.seq-1), limit: "1"});
      if (row?.seq === m.seq) {
        const facts = {spawnedByPlugin: m.kind === "note", sender: () => "thread"};
        const item = row.data?.item;
        const toolUse = row.type === "item/completed" && TOOL_USES.has(item?.type);
        // W571: a tool use is one tool entry, its call and result; a row logged before selects
        // among the call and the echo, as they were logged then.
        const legacy = toolUse && (split || m.kind === "echo");
        const entries = eventEntries(row, m.threadId, facts, {legacy});
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
          text = eventEntries(row, m.threadId, facts, {legacy, original: true})[index]!.text;
          availability = "canonical semantic message";
          // The selected entry holds the tool's result: a combined tool entry, or a legacy echo.
          const withResult = toolUse && (m.kind === "echo" || !legacy);
          if (item?.truncation && withResult) availability = RETAINED;
          if (row.type === "client/turn/requested") {
            const parts = senderParts(row.data);
            const input = m.kind === "work" && parts.length > 1 ? parts[index]?.input : row.data?.input;
            attachments = (input ?? []).filter((c: {type: string}) => ["localImage","localFile","image"].includes(c.type));
          }
          if (withResult) attachments = resultImages(item);
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
