// What the settings UI and the server exchange, as zod schemas shared by
// both sides (the frontend also checks restored cache entries with them).
//
// Secret inputs (header values, client secrets) flow in only: every view
// says whether one is set, never what it is.

import { z } from "zod";

export const SERVERS_CHANGED = "servers-changed";

/** A server's tool-name prefix, at most this long (names.ts). */
export const MAX_PREFIX = 20;

/** A prefix suggestion for a server name: "Linear (work)" → "linear-work". */
export function suggestPrefix(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_PREFIX)
    .replace(/-+$/, "");
  return slug || "mcp";
}

/**
 * The credential in a header value: what follows an auth scheme
 * ("Bearer abc" → "abc"), or the whole value when there is no scheme.
 */
export function headerCredential(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^[A-Za-z][A-Za-z0-9._-]*\s+(\S.*)$/.exec(value.trim());
  return match ? match[1] : value.trim();
}

const headerName = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "Use a valid HTTP header name.");
const secretValue = z
  .string()
  .max(16 * 1024)
  .refine((value) => !/[\r\n]/.test(value), "Must be one line.");

export const authInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("header"),
      headerName,
      /** Omit to keep the stored value. */
      headerValue: secretValue
        .refine(
          // The credential itself, not "Bearer " in front of it: shorter could not be masked.
          (value) => (headerCredential(value) ?? "").length >= 8,
          "Use a credential of at least 8 characters.",
        )
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("oauth"),
      clientId: z.string().trim().max(512).optional(),
      /** Omit to keep the stored value; "" clears it. */
      clientSecret: secretValue.refine((value) => value === "" || value.length >= 8, "Use a secret of at least 8 characters.").optional(),
      scope: z.string().trim().max(2048).optional(),
      clientMetadataUrl: z.string().trim().max(2048).optional(),
    })
    .strict(),
]);
export type AuthInput = z.infer<typeof authInputSchema>;

export const serverInputSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    prefix: z.string().trim().min(1).max(20),
    url: z.string().trim().min(1).max(2048),
    auth: authInputSchema,
  })
  .strict();
export type ServerInput = z.infer<typeof serverInputSchema>;

export const toolViewSchema = z.object({
  name: z.string(),
  upstreamName: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  schemaChanges: z.array(z.string()),
});

export const serverViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  url: z.string(),
  enabled: z.boolean(),
  auth: z.object({
    kind: z.enum(["none", "header", "oauth"]),
    headerName: z.string().nullable(),
    headerValueSet: z.boolean(),
    clientId: z.string().nullable(),
    clientSecretSet: z.boolean(),
    scope: z.string().nullable(),
    clientMetadataUrl: z.string().nullable(),
    authorized: z.boolean(),
    /** An authorization is waiting for its redirect. */
    pending: z.boolean(),
  }),
  state: z.enum(["disabled", "idle", "connecting", "connected", "needs-auth", "error"]),
  error: z.string().nullable(),
  server: z
    .object({
      name: z.string().nullable(),
      version: z.string().nullable(),
      protocolVersion: z.string().nullable(),
      transport: z.enum(["streamable-http", "sse"]),
      instructionsChars: z.number(),
      fetchedAt: z.number(),
    })
    .nullable(),
  tools: z.array(toolViewSchema),
  /** The tools agents get now (registered at the last plugin load). */
  liveToolCount: z.number(),
  /** Tool names another plugin already owns, so BB kept theirs. */
  conflicts: z.array(z.string()),
});
export type ServerView = z.infer<typeof serverViewSchema>;

export const listResultSchema = z.object({
  /** Grows with every change, across reloads too: the newer document wins. */
  revision: z.number(),
  servers: z.array(serverViewSchema),
  /** The tool surface changed; the plugin reloads to apply it. */
  reloadPending: z.boolean(),
});
export type ListResult = z.infer<typeof listResultSchema>;

