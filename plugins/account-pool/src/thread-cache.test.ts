// The thread cache state Initiatives reads before it gives more work to an idle worker (T142):
// prefix and coverage from the usage ledger, the warmer's live lease, and threads it cannot know.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { QUOTA_MIGRATIONS } from "./store.js";
import { CACHE_ROWS_SQL, threadCacheState, type ThreadCacheDeps } from "./thread-cache.js";

const T0 = Date.UTC(2026, 9, 7, 10);
const MINUTE = 60_000;
const SESSION = "6f1d3c1e-1111-4111-8111-111111111111";

function database(): Database.Database {
  const db = new Database(":memory:");
  for (const statement of QUOTA_MIGRATIONS) db.exec(statement);
  return db;
}

interface Row {
  at: number;
  kind?: "native" | "refresh" | "advisor";
  provider?: "claude" | "codex";
  session?: string;
  model?: string;
  ttl?: "5m" | "1h" | null;
  status?: number | null;
  read?: number | null;
  write?: number | null;
}

function insert(db: Database.Database, row: Row): void {
  db.prepare(
    `INSERT INTO usage_requests (at, kind, provider, session_key, thread_id, role, account_id, model,
       family, ttl, status, completed, latency_ms, cache_read_tokens, cache_write_tokens)
     VALUES (?, ?, ?, ?, NULL, NULL, 'acct', ?, 'opus', ?, ?, 1, 2000, ?, ?)`,
  ).run(
    row.at,
    row.kind ?? "native",
    row.provider ?? "claude",
    `session:${row.session ?? SESSION}`,
    row.model ?? "claude-opus-5-5",
    row.ttl === undefined ? "5m" : row.ttl,
    row.status === undefined ? 200 : row.status,
    row.read === undefined ? 400_000 : row.read,
    row.write === undefined ? 80_000 : row.write,
  );
}

function deps(db: Database.Database, overrides: Partial<ThreadCacheDeps> = {}): ThreadCacheDeps {
  return {
    db,
    session: async (threadId) => (threadId === "thr_w188" ? SESSION : null),
    lease: () => null,
    ...overrides,
  };
}

describe("threads.cacheState", () => {
  it("a cold session: its latest native request, the cached prefix and when the entry expired", async () => {
    const db = database();
    insert(db, { at: T0, read: 100_000, write: 20_000 });
    insert(db, { at: T0 + 10 * MINUTE });
    expect(await threadCacheState(deps(db), ["thr_w188"])).toEqual({
      threads: [
        {
          threadId: "thr_w188",
          cache: {
            sessionId: SESSION,
            model: "claude-opus-5-5",
            lastRequestAt: T0 + 10 * MINUTE,
            prefixTokens: 480_000,
            ttl: "5m",
            coveredUntil: T0 + 15 * MINUTE,
            leased: false,
          },
        },
      ],
    });
  });

  it("a refresh after the last native request moves the coverage; a 1h entry lives an hour", async () => {
    const db = database();
    insert(db, { at: T0, ttl: "1h" });
    insert(db, { at: T0 + 55 * MINUTE, kind: "refresh", ttl: "1h", read: 480_000, write: 0 });
    const [thread] = (await threadCacheState(deps(db), ["thr_w188"])).threads;
    expect(thread?.cache).toMatchObject({
      lastRequestAt: T0,
      prefixTokens: 480_000,
      ttl: "1h",
      coveredUntil: T0 + 115 * MINUTE,
    });
  });

  it("a live lease on the main model covers the entry until its own coveredUntil", async () => {
    const db = database();
    insert(db, { at: T0 });
    const leased = await threadCacheState(
      deps(db, { lease: () => ({ model: "claude-opus-5-5", coveredUntil: T0 + 40 * MINUTE }) }),
      ["thr_w188"],
    );
    expect(leased.threads[0]?.cache).toMatchObject({ leased: true, coveredUntil: T0 + 40 * MINUTE });
    // A lease on a helper's body does not keep the main conversation's entry alive.
    const helper = await threadCacheState(
      deps(db, { lease: () => ({ model: "claude-haiku-4-5", coveredUntil: T0 + 40 * MINUTE }) }),
      ["thr_w188"],
    );
    expect(helper.threads[0]?.cache).toMatchObject({ leased: false, coveredUntil: T0 + 5 * MINUTE });
  });

  it("the main conversation is the latest request with a large prefix, not a helper sent after it", async () => {
    const db = database();
    insert(db, { at: T0 });
    insert(db, { at: T0 + MINUTE, model: "claude-haiku-4-5", read: 0, write: 3_000 });
    insert(db, { at: T0 + 2 * MINUTE, read: 20_000, write: 1_000 });
    const [thread] = (await threadCacheState(deps(db), ["thr_w188"])).threads;
    expect(thread?.cache).toMatchObject({ model: "claude-opus-5-5", lastRequestAt: T0, prefixTokens: 480_000 });
  });

  it("an older model's larger history does not outrank the model the thread uses now", async () => {
    const db = database();
    insert(db, { at: T0, read: 800_000 });
    insert(db, { at: T0 + 30 * MINUTE, model: "claude-sonnet-5-5", read: 90_000, write: 10_000 });
    const [thread] = (await threadCacheState(deps(db), ["thr_w188"])).threads;
    expect(thread?.cache).toMatchObject({ model: "claude-sonnet-5-5", lastRequestAt: T0 + 30 * MINUTE, prefixTokens: 100_000 });
  });

  it("a session with only small requests reports its latest one", async () => {
    const db = database();
    insert(db, { at: T0, read: 10_000, write: 1_000 });
    insert(db, { at: T0 + MINUTE, model: "claude-haiku-4-5", read: 0, write: 3_000 });
    const [thread] = (await threadCacheState(deps(db), ["thr_w188"])).threads;
    expect(thread?.cache).toMatchObject({ model: "claude-haiku-4-5", prefixTokens: 3_000 });
  });

  it("ignores failed, uncounted, advisor and Codex rows and other sessions", async () => {
    const db = database();
    insert(db, { at: T0 });
    insert(db, { at: T0 + 20 * MINUTE, status: 529 });
    insert(db, { at: T0 + 21 * MINUTE, read: null });
    insert(db, { at: T0 + 22 * MINUTE, kind: "advisor" });
    insert(db, { at: T0 + 23 * MINUTE, provider: "codex" });
    insert(db, { at: T0 + 24 * MINUTE, session: "other" });
    const [thread] = (await threadCacheState(deps(db), ["thr_w188"])).threads;
    expect(thread?.cache).toMatchObject({ lastRequestAt: T0, coveredUntil: T0 + 5 * MINUTE });
  });

  it("an unknown thread, a session with no recorded request and a failed identity read are null", async () => {
    const db = database();
    insert(db, { at: T0, session: "someone-else" });
    const state = await threadCacheState(
      deps(db, {
        session: async (threadId) => {
          if (threadId === "thr_broken") throw new Error("events.list failed");
          return threadId === "thr_w188" ? SESSION : null;
        },
      }),
      ["thr_w188", "thr_codex", "thr_broken", "thr_w188"],
    );
    expect(state).toEqual({
      threads: [
        { threadId: "thr_w188", cache: null },
        { threadId: "thr_codex", cache: null },
        { threadId: "thr_broken", cache: null },
      ],
    });
  });

  it("reads a bounded number of the session's newest rows through the (session_key, at) index", async () => {
    const db = database();
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${CACHE_ROWS_SQL}`)
      .all("session:x") as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toContain("usage_requests_session_recent");
    expect(details).not.toContain("TEMP B-TREE");
    expect(CACHE_ROWS_SQL).toMatch(/ORDER BY at DESC LIMIT \d+$/);
    // Hundreds of newer helper rows push the main request out of the window: the newest is reported.
    insert(db, { at: T0 });
    for (let index = 1; index <= 150; index += 1)
      insert(db, { at: T0 + index * 1000, model: "claude-haiku-4-5", read: 0, write: 2_000 });
    const [thread] = (await threadCacheState(deps(db), ["thr_w188"])).threads;
    expect(thread?.cache).toMatchObject({ model: "claude-haiku-4-5", prefixTokens: 2_000 });
  });
});
