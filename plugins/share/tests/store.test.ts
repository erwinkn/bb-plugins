import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS, ShareStore, shareState, toShare, hashSlug } from "../server/store";
import { NOW } from "./fixtures";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose(); });
function setup() {
  const h = createFakePluginHost({ pluginId: "share" }); hosts.push(h);
  const db = h.bb.storage.database(); h.bb.storage.migrate(db, MIGRATIONS);
  const store = new ShareStore(db);
  const create = (threadId = "t") => store.create({ threadId, visibility: "access", allowedEmails: [" Person@Example.com "], includeTools: false, expiresAt: null, now: NOW });
  return { h, db, store, create };
}
describe("share store", () => {
  it("creates random identifiers and slugs, hashes lookup, and lists only the owning thread", () => {
    const { store, create } = setup(); const a = create(), b = create("other");
    expect(a.id).toMatch(/^shr_[a-z0-9]{12}$/); expect(a.slug).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a.slug, "base64url")).toHaveLength(32);
    expect(a.slugHash).toBe(hashSlug(a.slug)); expect(a.slug).not.toBe(b.slug);
    expect(store.lookup(a.slug)).toEqual(a); expect(store.lookup(a.slug + "x")).toBeNull();
    expect(store.list("t")).toEqual([a]); expect(a.allowedEmails).toEqual(["person@example.com"]);
    const shared = toShare(a, "https://bb.example.com", NOW);
    expect(shared.url).toBe(`https://bb.example.com/api/v1/plugins/share/http/s?k=${a.slug}`);
    expect(shared).not.toHaveProperty("slugHash"); expect(shared).not.toHaveProperty("slug");
  });
  it("updates, counts views, expires, and revokes idempotently", () => {
    const { store, create } = setup(); const a = create();
    const updated = store.update("t", a.id, { allowedEmails: ["@Example.com"], includeTools: true, expiresAt: NOW + 100 });
    expect(updated).toMatchObject({ allowedEmails: ["@example.com"], includeTools: true, expiresAt: NOW + 100 });
    expect(shareState(updated, NOW)).toBe("active"); expect(shareState(updated, NOW + 100)).toBe("expired");
    store.recordView(a.id, NOW + 1); store.recordView(a.id, NOW + 2);
    expect(store.get(a.id)).toMatchObject({ viewCount: 2, lastViewedAt: NOW + 2 });
    expect(store.update("t", a.id, { expiresAt: null }).expiresAt).toBeNull();
    expect(shareState(store.revoke("t", a.id, NOW + 3), NOW + 3)).toBe("revoked");
    expect(store.revoke("t", a.id, NOW + 4).revokedAt).toBe(NOW + 3);
  });
  it("revokes all shares of a deleted thread while preserving other threads", () => {
    const { store, create } = setup(); const a = create(), b = create(), c = create("other");
    expect(store.revokeThread("t", NOW)).toBe(2);
    expect(store.get(a.id)?.revokedAt).toBe(NOW); expect(store.get(b.id)?.revokedAt).toBe(NOW);
    expect(store.get(c.id)?.revokedAt).toBeNull(); expect(store.revokeThread("t", NOW + 1)).toBe(0);
  });
  it("rejects cross-thread writes and corrupt persisted rows", () => {
    const { store, create, db } = setup(); const a = create();
    expect(() => store.update("other", a.id, { includeTools: true })).toThrow("Unknown share");
    expect(() => store.revoke("other", a.id, NOW)).toThrow("Unknown share");
    db.prepare("UPDATE shares SET allowed_emails = ? WHERE id = ?").run('["bad"]', a.id);
    expect(() => store.get(a.id)).toThrow("Invalid allow list entry");
  });
});
