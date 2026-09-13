import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { id, revision, noteSchema, scopeSchema, saveSchema, targetSchema, historySchema, writeResultSchema } from "./model";

export const rpcContract = defineRpcContract({
  open: { input: z.object({ threadId: id }), output: z.object({ scope: scopeSchema, note: noteSchema }) },
  get: { input: targetSchema, output: noteSchema },
  save: { input: saveSchema, output: writeResultSchema },
  history: { input: targetSchema, output: z.array(historySchema) },
  version: { input: targetSchema.extend({ revision }), output: noteSchema },
  restore: { input: targetSchema.extend({ revision, expectedRevision: revision }), output: writeResultSchema },
  export: { input: targetSchema, output: z.object({ markdown: z.string(), note: noteSchema }) },
});
