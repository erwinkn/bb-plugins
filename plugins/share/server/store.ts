import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { normalizeEntries } from "../lib/allow";
import { shareSchema, buildShareUrl, type Share, type Visibility } from "../lib/model";

export const MIGRATIONS = [
  `CREATE TABLE shares (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('access', 'public')),
    slug TEXT NOT NULL,
    slug_hash TEXT NOT NULL UNIQUE,
    allowed_emails TEXT NOT NULL DEFAULT '[]',
    include_tools INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    expires_at INTEGER,
    last_viewed_at INTEGER,
    view_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX shares_thread ON shares(thread_id)`,
];

const storedSchema = shareSchema.omit({ url: true, state: true }).extend({
  slug: z.string().regex(/^[A-Za-z0-9_-]{43}$/), slugHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type StoredShare = z.infer<typeof storedSchema>;
const SELECT = `SELECT id, thread_id AS threadId, visibility, slug, slug_hash AS slugHash,
  allowed_emails AS allowedEmails, include_tools AS includeTools, created_at AS createdAt,
  revoked_at AS revokedAt, expires_at AS expiresAt, last_viewed_at AS lastViewedAt, view_count AS viewCount FROM shares`;

function decode(raw: unknown): StoredShare | null {
  if (raw === undefined) return null;
  const row = z.object({ allowedEmails: z.string(), includeTools: z.union([z.literal(0), z.literal(1)]) }).passthrough().parse(raw);
  const share = storedSchema.parse({ ...row, allowedEmails: JSON.parse(row.allowedEmails), includeTools: row.includeTools === 1 });
  share.allowedEmails = share.visibility === "public" ? [] : normalizeEntries(share.allowedEmails);
  return share;
}
export function hashSlug(slug: string): string {
  return createHash("sha256").update(slug).digest("hex");
}
export function shareState(share: StoredShare, now: number): Share["state"] {
  return share.revokedAt !== null ? "revoked" : share.expiresAt !== null && share.expiresAt <= now ? "expired" : "active";
}
export function toShare(share: StoredShare, baseUrl: string, now: number): Share {
  const { slug, slugHash: _hash, ...rest } = share;
  return { ...rest, url: buildShareUrl(baseUrl, share.visibility, slug), state: shareState(share, now) };
}

export class ShareStore {
  constructor(private readonly db: Database.Database) {}

  create(input: { threadId: string; visibility: Visibility; allowedEmails: string[]; includeTools: boolean; expiresAt: number | null; now: number }): StoredShare {
    const id = `shr_${Array.from({ length: 12 }, () => randomInt(36).toString(36)).join("")}`;
    const slug = randomBytes(32).toString("base64url");
    const allowed = input.visibility === "public" ? [] : normalizeEntries(input.allowedEmails);
    this.db.prepare(`INSERT INTO shares (id, thread_id, visibility, slug, slug_hash, allowed_emails, include_tools, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.threadId, input.visibility, slug, hashSlug(slug), JSON.stringify(allowed), Number(input.includeTools), input.now, input.expiresAt);
    return this.get(id)!;
  }

  get(id: string): StoredShare | null { return decode(this.db.prepare(`${SELECT} WHERE id = ?`).get(id)); }

  list(threadId: string): StoredShare[] {
    return this.db.prepare(`${SELECT} WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC`).all(threadId).map((row) => decode(row)!);
  }

  lookup(slug: string): StoredShare | null {
    const hash = hashSlug(slug);
    const share = decode(this.db.prepare(`${SELECT} WHERE slug_hash = ?`).get(hash));
    if (!share) return null;
    const presented = Buffer.from(hash, "hex");
    const stored = Buffer.from(share.slugHash, "hex");
    return presented.length === stored.length && timingSafeEqual(presented, stored) ? share : null;
  }

  getForThread(threadId: string, id: string): StoredShare {
    const share = this.get(id);
    if (!share || share.threadId !== threadId) throw new Error("Unknown share for this thread.");
    return share;
  }

  update(threadId: string, id: string, changes: { allowedEmails?: string[]; includeTools?: boolean; expiresAt?: number | null }): StoredShare {
    const current = this.getForThread(threadId, id);
    const allowed = current.visibility === "public" ? [] : normalizeEntries(changes.allowedEmails ?? current.allowedEmails);
    this.db.prepare("UPDATE shares SET allowed_emails = ?, include_tools = ?, expires_at = ? WHERE id = ? AND thread_id = ?")
      .run(JSON.stringify(allowed), Number(changes.includeTools ?? current.includeTools), changes.expiresAt === undefined ? current.expiresAt : changes.expiresAt, id, threadId);
    return this.getForThread(threadId, id);
  }

  revoke(threadId: string, id: string, now: number): StoredShare {
    this.getForThread(threadId, id);
    this.db.prepare("UPDATE shares SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND thread_id = ?").run(now, id, threadId);
    return this.getForThread(threadId, id);
  }

  revokeThread(threadId: string, now: number): number {
    return this.db.prepare("UPDATE shares SET revoked_at = ? WHERE thread_id = ? AND revoked_at IS NULL").run(now, threadId).changes;
  }

  recordView(id: string, now: number): void {
    this.db.prepare("UPDATE shares SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?").run(now, id);
  }
}
