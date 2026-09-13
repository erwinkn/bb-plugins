import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";

// Media uploads need their own storage lifecycle. Keep this first version
// focused on notes; links, tables and code stay fully editable.
const { audio, file, image, video, ...blocks } = defaultBlockSpecs;
export const editorSchema = BlockNoteSchema.create({ blockSpecs: blocks });
export type NoteBlock = typeof editorSchema.Block;
