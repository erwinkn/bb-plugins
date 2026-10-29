// The settings UI's RPC contract. Reads answer from memory at once; writes
// that need the remote server (Connect) wait for it with a deadline, and
// every change also reaches open UIs through the `servers-changed` signal.

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { listResultSchema, serverInputSchema } from "./schemas";

export * from "./schemas";

const id = z.object({ id: z.string().min(1) }).strict();

export const rpcContract = defineRpcContract({
  list: { input: z.null(), output: listResultSchema },
  add: { input: serverInputSchema, output: z.object({ id: z.string() }) },
  update: { input: serverInputSchema.extend({ id: z.string().min(1) }).strict(), output: z.object({ ok: z.literal(true) }) },
  remove: { input: id, output: z.object({ ok: z.literal(true) }) },
  setEnabled: { input: id.extend({ enabled: z.boolean() }).strict(), output: z.object({ ok: z.literal(true) }) },
  reconnect: { input: id, output: z.object({ ok: z.literal(true) }) },
  /**
   * Start OAuth: `origin` is the BB origin the browser uses, which the
   * redirect URI is built on. Null URL: stored credentials were enough.
   */
  startAuth: {
    input: id.extend({ origin: z.string().url() }).strict(),
    output: z.object({ authorizationUrl: z.string().nullable(), redirectUri: z.string() }),
  },
  /** Finish OAuth from the URL the browser was redirected to (paste fallback). */
  completeAuth: { input: id.extend({ redirectedUrl: z.string().min(1).max(8192) }).strict(), output: z.object({ ok: z.literal(true) }) },
  /** Forget this server's tokens (and dynamic registration). */
  disconnect: { input: id, output: z.object({ ok: z.literal(true) }) },
});
