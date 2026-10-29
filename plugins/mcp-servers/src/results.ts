// An MCP CallToolResult as a BB tool result. BB carries text and image
// parts, so everything else becomes text that keeps what an agent needs:
//
//   text                → text
//   image               → image
//   audio               → a text note (BB has no audio part)
//   resource_link       → "[resource link] name: uri (mime) — description"
//   resource (embedded) → its text under a "[resource uri]" line; an image
//                         blob as an image; any other blob as a note
//   structuredContent   → JSON text, unless a text part already carries it
//                         (servers SHOULD mirror it there)
//   isError             → isError
//
// Text is capped per part and in total; every byte lands in the agent's
// context.

import type { PluginAgentToolContentPart, PluginAgentToolResult } from "@get-bb/plugin-sdk";

export const MAX_TEXT_PART_BYTES = 100 * 1024;
export const MAX_TEXT_TOTAL_BYTES = 200 * 1024;
export const MAX_IMAGE_TOTAL_CHARS = 8 * 1024 * 1024;

type Part = Record<string, unknown>;

export interface McpCallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function sliceBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  // Back off to a character boundary: a cut UTF-8 sequence decodes to U+FFFD.
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�$/, "");
}

function base64Bytes(data: string): number {
  return Math.floor((data.length * 3) / 4);
}

function sameJson(text: string, value: unknown): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(value);
  } catch {
    return false;
  }
}

export function toBbResult(result: McpCallResult): PluginAgentToolResult {
  const parts: PluginAgentToolContentPart[] = [];
  let textBytes = 0;
  let imageChars = 0;
  let truncated = false;
  const text = (value: string) => {
    const room = Math.min(MAX_TEXT_PART_BYTES, MAX_TEXT_TOTAL_BYTES - textBytes);
    if (room <= 0) {
      truncated = true;
      return;
    }
    const slice = sliceBytes(value, room);
    if (slice.length < value.length) truncated = true;
    textBytes += Buffer.byteLength(slice, "utf8");
    parts.push({ type: "text", text: slice });
  };
  const image = (data: string, mimeType: string, label: string) => {
    if (!/^image\/[A-Za-z0-9.+-]{1,64}$/.test(mimeType)) {
      text(`[${label}: not shown, its type is not a plain image MIME type]`);
      return;
    }
    if (imageChars + data.length > MAX_IMAGE_TOTAL_CHARS) {
      text(`[${label}: ${mimeType}, ${base64Bytes(data)} bytes, omitted: images over 8 MiB in one result]`);
      return;
    }
    imageChars += data.length;
    parts.push({ type: "image", data, mimeType });
  };

  const content = Array.isArray(result.content) ? (result.content as Part[]) : [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const type = str(part.type);
    if (type === "text" && str(part.text) !== undefined) {
      text(part.text as string);
    } else if (type === "image" && str(part.data) && str(part.mimeType)) {
      image(part.data as string, part.mimeType as string, "image");
    } else if (type === "audio") {
      text(`[audio: ${str(part.mimeType) ?? "unknown type"}, ${base64Bytes(str(part.data) ?? "")} bytes, not shown: BB tools return text and images]`);
    } else if (type === "resource_link") {
      const name = str(part.title) ?? str(part.name);
      const mime = str(part.mimeType);
      const description = str(part.description);
      text(
        `[resource link] ${name ? `${name}: ` : ""}${str(part.uri) ?? ""}${mime ? ` (${mime})` : ""}${description ? ` — ${description}` : ""}`,
      );
    } else if (type === "resource" && typeof part.resource === "object" && part.resource !== null) {
      const resource = part.resource as Part;
      const uri = str(resource.uri) ?? "";
      const mime = str(resource.mimeType);
      if (str(resource.text) !== undefined) {
        text(`[resource ${uri}${mime ? ` (${mime})` : ""}]\n${resource.text as string}`);
      } else if (str(resource.blob) !== undefined && mime?.startsWith("image/")) {
        image(resource.blob as string, mime, `resource ${uri}`);
      } else {
        text(`[resource ${uri}${mime ? ` (${mime})` : ""}: ${base64Bytes(str(resource.blob) ?? "")} bytes of binary data, not shown]`);
      }
    } else {
      text(JSON.stringify(part));
    }
  }

  const structured = result.structuredContent;
  if (structured !== undefined && structured !== null) {
    const mirrored = content.some((part) => part?.type === "text" && sameJson(str(part.text) ?? "", structured));
    if (!mirrored) text(JSON.stringify(structured, null, 2));
  }
  if (parts.length === 0) parts.push({ type: "text", text: "(empty result)" });
  if (truncated) parts.push({ type: "text", text: "[result truncated: text is capped at 100 KiB per part and 200 KiB in total]" });
  return { content: parts, isError: result.isError === true };
}
