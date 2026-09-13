import { z } from "zod";

export const CHANNEL = "scratchpad-changed";
export const MAX_DOCUMENT_BYTES = 1_000_000;
export const HISTORY_LIMIT = 100;
export const id = z.string().min(1).max(200);
export const revision = z.number().int().nonnegative();

const styles = z.object({
  bold: z.boolean().optional(), italic: z.boolean().optional(),
  underline: z.boolean().optional(), strike: z.boolean().optional(),
  code: z.boolean().optional(), textColor: z.string().max(100).optional(),
  backgroundColor: z.string().max(100).optional(),
}).strict();
const text = z.object({ type: z.literal("text"), text: z.string(), styles }).strict();
const href = z.string().max(8000).refine((value) => {
  const normalized = value.replace(/[\u0000-\u0020\u007f]/g, "");
  return !/^[a-z][a-z\d+.-]*:/i.test(normalized) || /^(https?|mailto|tel):/i.test(normalized);
}, "Use a web, email, phone, or relative link.");
const inline = z.union([text, z.object({ type: z.literal("link"), href, content: z.array(text) }).strict()]);
const cell = z.object({
  type: z.literal("tableCell"),
  props: z.object({
    colspan: z.number().int().min(1).max(100), rowspan: z.number().int().min(1).max(100),
    backgroundColor: z.string().max(100), textColor: z.string().max(100),
    textAlignment: z.enum(["left", "center", "right", "justify"]),
  }).strict(),
  content: z.array(inline),
}).strict();
const table = z.object({
  type: z.literal("tableContent"),
  columnWidths: z.array(z.number().positive().nullish().transform((width) => width ?? null)).optional(),
  headerRows: z.number().int().min(0).max(100).optional(),
  headerCols: z.number().int().min(0).max(100).optional(),
  rows: z.array(z.object({ cells: z.array(z.union([z.array(inline), cell])).min(1).max(100) }).strict()).min(1).max(200),
}).strict();
export const blockSchema = z.strictObject({
  id,
  type: z.enum(["paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem", "quote", "codeBlock", "table", "divider"]),
  props: z.record(z.string().max(100), z.union([z.string().max(8000), z.number().finite(), z.boolean()])),
  content: z.union([z.array(inline), table, z.string()]).optional(),
  get children() { return z.array(blockSchema).max(2000); },
});
export type NoteDocument = z.infer<typeof blockSchema>[];

export const documentSchema = z.array(blockSchema).min(1).max(2000).superRefine((blocks, ctx) => {
  const seen = new Set<string>();
  const walk = (items: NoteDocument, depth: number) => {
    if (depth > 20) { ctx.addIssue({ code: "custom", message: "Notes can nest up to 20 levels." }); return; }
    for (const block of items) {
      if (seen.has(block.id)) ctx.addIssue({ code: "custom", message: `Duplicate block id: ${block.id}` });
      seen.add(block.id);
      if (block.type === "table" ? !block.content || Array.isArray(block.content) || typeof block.content === "string" : block.content && !Array.isArray(block.content) && typeof block.content !== "string") {
        ctx.addIssue({ code: "custom", message: `Invalid content for ${block.type}.` });
      }
      if (block.type === "heading" && ![1, 2, 3, 4, 5, 6].includes(Number(block.props.level))) ctx.addIssue({ code: "custom", message: "Invalid heading level." });
      walk(block.children, depth + 1);
    }
  };
  walk(blocks, 0);
  if (seen.size > 2000) ctx.addIssue({ code: "custom", message: "A scratchpad can contain up to 2,000 blocks." });
  if (new TextEncoder().encode(JSON.stringify(blocks)).length > MAX_DOCUMENT_BYTES) ctx.addIssue({ code: "custom", message: "This scratchpad has reached its 1 MB limit." });
});

export const scopeSchema = z.object({
  environmentId: id, projectId: id, projectName: z.string(),
  environmentName: z.string(), path: z.string(), branch: z.string().nullable(),
});
export type Scope = z.infer<typeof scopeSchema>;
export const noteSchema = z.object({
  environmentId: id, document: documentSchema, revision,
  updatedAt: z.number(), author: z.string(), schemaVersion: z.literal(1),
});
export type Note = z.infer<typeof noteSchema>;
export const historySchema = noteSchema.omit({ document: true });
export const writeResultSchema = z.object({ ok: z.boolean(), note: noteSchema });
export type WriteResult = z.infer<typeof writeResultSchema>;
export const targetSchema = z.object({ threadId: id, environmentId: id });
export const saveSchema = targetSchema.extend({ expectedRevision: revision, document: documentSchema });
export const markdownSchema = z.string().trim().min(1).max(100_000);
export const editSchema = z.object({ expectedRevision: revision, blockId: id, markdown: markdownSchema.nullable() });

export function emptyDocument(environmentId: string): NoteDocument {
  return [{ id: `empty-${environmentId.slice(0, 194)}`, type: "paragraph", props: { textColor: "default", backgroundColor: "default", textAlignment: "left" }, content: [], children: [] }];
}

/** A targeted edit preserves all unrelated blocks, their IDs and formatting. */
export function replaceBlock(document: NoteDocument, blockId: string, replacement: NoteDocument): NoteDocument {
  let found = false;
  const visit = (items: NoteDocument): NoteDocument => items.flatMap((block) => {
    if (block.id === blockId) { found = true; return replacement; }
    return [{ ...block, children: visit(block.children) }];
  });
  const result = visit(document);
  if (!found) throw new Error("Block not found. Read the scratchpad again before editing.");
  return result;
}
