// What the plugin keeps on disk, in its own folder (<dataDir>/plugins/<id>/):
//
//   servers.json  each server's settings and the last tool list it served,
//                 so tools register at activation without waiting on the
//                 network. No secrets.
//   secrets.json  header values, OAuth client secrets, tokens and in-flight
//                 authorization state. Mode 600; never logged, never sent to
//                 the UI or an agent.
//
// Both files are small and written whole: a temp file (created with the
// final mode) renamed over the old one, so a crash leaves either version.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { headerCredential } from "./schemas";

export const authConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("header"), headerName: z.string() }),
  z.object({
    kind: z.literal("oauth"),
    /** Pre-registered client; absent means dynamic registration. */
    clientId: z.string().optional(),
    /** Scopes to request; absent means what the server advertises. */
    scope: z.string().optional(),
    /** A client ID metadata document the user hosts (SEP-991). */
    clientMetadataUrl: z.string().optional(),
  }),
]);
export type AuthConfig = z.infer<typeof authConfigSchema>;

export const cachedToolSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z.record(z.string(), z.unknown()).optional(),
});
export type CachedTool = z.infer<typeof cachedToolSchema>;

export const serverCacheSchema = z.object({
  serverName: z.string().optional(),
  serverVersion: z.string().optional(),
  protocolVersion: z.string().optional(),
  transport: z.enum(["streamable-http", "sse"]),
  instructions: z.string().optional(),
  tools: z.array(cachedToolSchema),
  fetchedAt: z.number(),
});
export type ServerCache = z.infer<typeof serverCacheSchema>;

export const serverConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  url: z.string(),
  enabled: z.boolean(),
  auth: authConfigSchema,
  createdAt: z.number(),
  cache: serverCacheSchema.optional(),
});
export type ServerConfig = z.infer<typeof serverConfigSchema>;

const serversFileSchema = z.object({
  version: z.literal(1),
  servers: z.array(serverConfigSchema),
  /** When this plugin last asked BB to reload it, across loads. */
  lastReloadAt: z.number().optional(),
});

export const oauthSecretsSchema = z.object({
  clientSecret: z.string().optional(),
  /** The issuer a pre-registered client was first used with (SEP-2352). */
  clientIssuer: z.string().optional(),
  /** Dynamically registered clients, by the redirect URI each was registered for. */
  clients: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  tokens: z.record(z.string(), z.unknown()).optional(),
  tokensSavedAt: z.number().optional(),
  /** The redirect URI of the client the tokens were issued to (refresh uses it). */
  tokensRedirectUri: z.string().optional(),
  discovery: z.record(z.string(), z.unknown()).optional(),
  pending: z
    .object({
      state: z.string(),
      codeVerifier: z.string(),
      redirectUri: z.string(),
      createdAt: z.number(),
    })
    .optional(),
});
export type OAuthSecrets = z.infer<typeof oauthSecretsSchema>;

const serverSecretsSchema = z.object({
  headerValue: z.string().optional(),
  oauth: oauthSecretsSchema.optional(),
});
export type ServerSecrets = z.infer<typeof serverSecretsSchema>;

const secretsFileSchema = z.object({
  version: z.literal(1),
  servers: z.record(z.string(), serverSecretsSchema),
});

function writeAtomic(path: string, data: unknown, mode: number): void {
  const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode, flag: "wx" });
  renameSync(temp, path);
  // A file that predates this code may carry a wider mode.
  chmodSync(path, mode);
}

export class StoreReadError extends Error {}

/** Shorter credentials are refused at input: they could not be masked reliably. */
export const MIN_SECRET_CHARS = 8;
/** Issued credentials (tokens, registered secrets) are masked down to this length. */
const MIN_ISSUED_CHARS = 4;

/** `application/x-www-form-urlencoded`, as URLSearchParams writes a token request body. */
function formEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

/**
 * The ways one secret can appear in text that left this process: raw, URL
 * and form encoded, base64 and base64url, and escaped inside a JSON string
 * once or twice (an error that quotes a JSON body, then serialized again).
 */
function encodings(value: string): string[] {
  const out = new Set<string>();
  const escape = (text: string) => JSON.stringify(text).slice(1, -1);
  for (const form of [value, encodeURIComponent(value), formEncode(value)]) {
    // Escaped once (a JSON body) and twice (an error quoting that body, then serialized).
    out.add(form);
    out.add(escape(form));
    out.add(escape(escape(form)));
  }
  out.add(Buffer.from(value, "utf8").toString("base64"));
  out.add(Buffer.from(value, "utf8").toString("base64url"));
  return [...out].filter((form) => form.length > 0);
}


const RETIRED_TTL_MS = 60 * 60_000;

/** A missing file starts empty; anything else stops the load and leaves the file alone. */
function readJson<T>(path: string, schema: z.ZodType<T>, fallback: T): T {
  if (!existsSync(path)) return fallback;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Never echo the parse error: it quotes the file, and secrets.json holds secrets.
    throw new StoreReadError(`${path} is not valid JSON. Fix or move it, then reload the plugin.`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new StoreReadError(`${path} does not have the expected shape. Fix or move it, then reload the plugin.`);
  return parsed.data;
}

export class Store {
  private servers: ServerConfig[];
  private secrets: Record<string, ServerSecrets>;
  private lastReloadAt: number | undefined;
  /**
   * Per server, bumped whenever its authorization is reset (forget, remove,
   * a new URL or client). An OAuth operation started before a bump must not
   * write: its tokens or client belong to what the user just discarded.
   */
  private readonly epochs = new Map<string, number>();
  /** Secret forms replaced or removed recently, by when (see allSecretValues). */
  private readonly retired = new Map<string, number>();
  private readonly serversPath: string;
  private readonly secretsPath: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.serversPath = join(dir, "servers.json");
    this.secretsPath = join(dir, "secrets.json");
    const file = readJson(this.serversPath, serversFileSchema, { version: 1, servers: [] });
    this.servers = file.servers;
    this.lastReloadAt = file.lastReloadAt;
    this.secrets = readJson(this.secretsPath, secretsFileSchema, { version: 1, servers: {} }).servers;
    if (existsSync(this.secretsPath)) chmodSync(this.secretsPath, 0o600);
  }

  list(): readonly ServerConfig[] {
    return this.servers;
  }

  get(id: string): ServerConfig | undefined {
    return this.servers.find((server) => server.id === id);
  }

  put(server: ServerConfig): void {
    const index = this.servers.findIndex((entry) => entry.id === server.id);
    if (index === -1) this.servers = [...this.servers, server];
    else this.servers = this.servers.map((entry, i) => (i === index ? server : entry));
    this.writeServers();
  }

  remove(id: string): void {
    this.bumpEpoch(id);
    this.retire(this.secretForms(id), new Set());
    this.servers = this.servers.filter((server) => server.id !== id);
    this.writeServers();
    if (this.secrets[id]) {
      const { [id]: _removed, ...rest } = this.secrets;
      this.secrets = rest;
      this.writeSecrets();
    }
  }

  getLastReloadAt(): number {
    return this.lastReloadAt ?? 0;
  }

  setLastReloadAt(at: number): void {
    this.lastReloadAt = at;
    this.writeServers();
  }

  epoch(id: string): number {
    return this.epochs.get(id) ?? 0;
  }

  bumpEpoch(id: string): void {
    this.epochs.set(id, this.epoch(id) + 1);
  }

  secretsFor(id: string): ServerSecrets {
    return this.secrets[id] ?? {};
  }

  /**
   * Every form in which a secret the store holds (or held within the last
   * RETIRED_TTL_MS) can leave this process, for masking text that may echo
   * one: the raw value, its URL and base64 encodings, and HTTP Basic
   * `client_id:client_secret` the way token requests send it. A rotated
   * token stays here a while, so a response to a request that used it is
   * still masked after the store moved on.
   */
  allSecretValues(now = Date.now()): string[] {
    const values = new Set<string>();
    for (const id of Object.keys(this.secrets)) for (const value of this.secretForms(id)) values.add(value);
    for (const [value, retiredAt] of this.retired) {
      if (now - retiredAt > RETIRED_TTL_MS) this.retired.delete(value);
      else values.add(value);
    }
    return [...values];
  }

  private secretForms(id: string): Set<string> {
    const forms = new Set<string>();
    // `min`: what the user typed was checked at input (MIN_SECRET_CHARS);
    // what an authorization server issued is masked whatever its length,
    // down to a floor below which masking would only garble text.
    const add = (value: unknown, min = MIN_SECRET_CHARS) => {
      if (typeof value !== "string" || value.length < min) return;
      for (const form of encodings(value)) forms.add(form);
    };
    const basic = (clientId: unknown, secret: unknown) => {
      if (typeof clientId !== "string" || typeof secret !== "string" || !secret) return;
      // RFC 6749 §2.3.1 form-encodes both before joining; some clients don't.
      for (const [user, pass] of [
        [clientId, secret],
        [encodeURIComponent(clientId), encodeURIComponent(secret)],
        [formEncode(clientId), formEncode(secret)],
      ])
        for (const form of encodings(Buffer.from(`${user}:${pass}`, "utf8").toString("base64"))) forms.add(form);
    };
    const secrets = this.secrets[id] ?? {};
    add(secrets.headerValue);
    // "Bearer abc…": the credential alone may be echoed too.
    add(headerCredential(secrets.headerValue));
    for (const part of secrets.headerValue?.split(/\s+/) ?? []) add(part);
    const oauth = secrets.oauth;
    if (oauth) {
      add(oauth.clientSecret);
      const auth = this.get(id)?.auth;
      if (auth?.kind === "oauth") basic(auth.clientId, oauth.clientSecret);
      add(oauth.pending?.codeVerifier, MIN_ISSUED_CHARS);
      for (const key of ["access_token", "refresh_token", "id_token"]) add(oauth.tokens?.[key], MIN_ISSUED_CHARS);
      for (const client of Object.values(oauth.clients ?? {})) {
        add(client.client_secret, MIN_ISSUED_CHARS);
        basic(client.client_id, client.client_secret);
      }
    }
    return forms;
  }

  private retire(before: Set<string>, after: Set<string>): void {
    const now = Date.now();
    for (const value of before) if (!after.has(value)) this.retired.set(value, now);
  }

  updateSecrets(id: string, update: (current: ServerSecrets) => ServerSecrets): void {
    if (!this.get(id)) return;
    const before = this.secretForms(id);
    this.secrets = { ...this.secrets, [id]: update(this.secrets[id] ?? {}) };
    this.retire(before, this.secretForms(id));
    this.writeSecrets();
  }

  private writeServers(): void {
    writeAtomic(
      this.serversPath,
      { version: 1, servers: this.servers, ...(this.lastReloadAt !== undefined ? { lastReloadAt: this.lastReloadAt } : {}) },
      0o644,
    );
  }

  private writeSecrets(): void {
    writeAtomic(this.secretsPath, { version: 1, servers: this.secrets }, 0o600);
  }
}
