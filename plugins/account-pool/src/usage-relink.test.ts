// Relinking ledger rows to threads over a real SQLite database: which sessions link, which stay
// alone, idempotence, and a rollup that ends up as if the rows had named their thread all along.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { formatRelink } from "./cli.js";
import { UsageLedger, type RequestRecord } from "./ledger.js";
import { QUOTA_MIGRATIONS } from "./store.js";
import { applyRelink, planRelink, type RelinkSources, type RelinkStore } from "./usage-relink.js";
import { UsageRollup, usageStatsInputSchema } from "./usage-rollup.js";

const T0 = Date.UTC(2026, 9, 6, 10);
const MINUTE = 60_000;
const NOW = T0 + 24 * 60 * MINUTE;

function database(): Database.Database {
  const db = new Database(":memory:");
  for (const statement of QUOTA_MIGRATIONS) db.exec(statement);
  return db;
}

interface Row {
  at: number;
  session: string | null;
  thread?: string | null;
  role?: string | null;
  provider?: "claude" | "codex";
  kind?: "native" | "advisor";
}

function insert(db: Database.Database, row: Row): void {
  db.prepare(
    `INSERT INTO usage_requests (at, kind, provider, session_key, thread_id, role, account_id, model,
       family, ttl, status, completed, latency_ms, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens)
     VALUES (?, ?, ?, ?, ?, ?, 'acct-a', 'claude-opus-5-5', 'opus', '5m', 200, 1, 1000, 10, 100,
       50000, 2000, 2000, 0)`,
  ).run(
    row.at,
    row.kind ?? "native",
    row.provider ?? "claude",
    row.session === null ? null : `session:${row.session}`,
    row.thread ?? null,
    row.role ?? null,
  );
}

// s1: two hours of rows, 20 minutes apart so the rollup classifies them after expiry; one thread
// reports it. s2: two threads report it. s3: one thread reports it, but its rows name another.
// s4: half its rows already name the thread that reports it. s5: no thread reports it. A Codex
// session links like a Claude one, and a row with no session is never touched.
function ledger(db: Database.Database, labels: "before" | "after") {
  const linked = labels === "after";
  for (let minute = 0; minute < 120; minute += 20)
    insert(db, { at: T0 + minute * MINUTE, session: "s1", ...(linked && { thread: "thr_a", role: "work" }) });
  insert(db, { at: T0 + 1 * MINUTE, session: "s2" });
  insert(db, { at: T0 + 2 * MINUTE, session: "s3" });
  insert(db, { at: T0 + 3 * MINUTE, session: "s3", thread: "thr_c", role: "adhoc" });
  insert(db, { at: T0 + 4 * MINUTE, session: "s4", ...(linked && { thread: "thr_c", role: "adhoc" }) });
  insert(db, { at: T0 + 5 * MINUTE, session: "s4", thread: "thr_c", role: "adhoc" });
  insert(db, { at: T0 + 6 * MINUTE, session: "s5" });
  insert(db, {
    at: T0 + 7 * MINUTE,
    session: "codex-1",
    provider: "codex",
    ...(linked && { thread: "thr_x", role: "standalone" }),
  });
  insert(db, { at: T0 + 8 * MINUTE, session: null, kind: "advisor", provider: "codex" });
}

// The ledger as relink sees it, at NOW: nothing queued and nothing dropped unless a test says so.
function store(
  db: Database.Database,
  ledger: Partial<RelinkStore["ledger"]> = {},
  now = NOW,
): RelinkStore {
  return {
    db,
    ledger: {
      queuedSessions: () => new Set(),
      status: () => ({ since: 0, rowsWritten: 0, writeErrors: 0, busyRetries: 0, dropped: 0, lastError: null }),
      ...ledger,
    },
    now: () => now,
  };
}

function sources(overrides: Partial<RelinkSources> = {}): RelinkSources & { reads: string[] } {
  const reported: Record<string, string[]> = {
    thr_a: ["s0", "s1", "s2"],
    thr_b: ["s2"],
    thr_d: ["s3"],
    thr_c: ["s4"],
    thr_x: ["codex-1"],
    thr_idle: [],
  };
  const roles: Record<string, string | null> = { thr_a: "work", thr_c: "adhoc", thr_x: "standalone" };
  const reads: string[] = [];
  return {
    reads,
    threads: async () => Object.keys(reported),
    sessions: async (threadId) => {
      reads.push(threadId);
      return reported[threadId] ?? [];
    },
    role: async (threadId) => roles[threadId] ?? null,
    ...overrides,
  };
}

function rollup(db: Database.Database, now = T0 + 24 * 60 * MINUTE) {
  const r = new UsageRollup({
    db,
    now: () => now,
    openSince: () => null,
    retentionDays: () => 30,
    log: () => undefined,
  });
  return { rollup: r, catchUp: () => { while (r.step() === "behind"); } };
}

const hourly = (db: Database.Database) =>
  db.prepare("SELECT * FROM usage_hourly ORDER BY hour, provider, kind, model, role, thread_id").all();

const unlinkedRows = (db: Database.Database) =>
  (db.prepare("SELECT count(*) AS n FROM usage_requests WHERE thread_id IS NULL").get() as { n: number }).n;

describe("planRelink", () => {
  it("links a session exactly one thread claims, and leaves the rest alone", async () => {
    const db = database();
    ledger(db, "before");
    const plan = await planRelink(store(db), sources());
    const keys = (sessions: Array<{ sessionKey: string }>) => sessions.map((session) => session.sessionKey);
    expect(plan.links).toEqual([
      { sessionKey: "session:s1", provider: "claude", rows: 6, threadId: "thr_a", role: "work" },
      { sessionKey: "session:s4", provider: "claude", rows: 1, threadId: "thr_c", role: "adhoc" },
      { sessionKey: "session:codex-1", provider: "codex", rows: 1, threadId: "thr_x", role: "standalone" },
    ]);
    expect(plan.ambiguous).toEqual([
      { sessionKey: "session:s2", provider: "claude", rows: 1, threadIds: ["thr_a", "thr_b"] },
      { sessionKey: "session:s3", provider: "claude", rows: 1, threadIds: ["thr_c", "thr_d"] },
    ]);
    expect(keys(plan.unmapped)).toEqual(["session:s5"]);
    expect(plan.unlinked.reduce((total, session) => total + session.rows, 0)).toBe(11);
  });

  it("fails rather than link when a thread's identity cannot be read", async () => {
    const db = database();
    ledger(db, "before");
    await expect(
      planRelink(store(db), sources({ sessions: async () => { throw new Error("thread events: 500"); } })),
    ).rejects.toThrow("thread events: 500");
  });

  it("reads nothing from BB when every row names its thread", async () => {
    const db = database();
    insert(db, { at: T0, session: "s1", thread: "thr_a" });
    const source = sources();
    expect(await planRelink(store(db), source)).toEqual({
      throughRowid: 1,
      ledgerDropped: 0,
      unlinked: [],
      links: [],
      recent: [],
      unmapped: [],
      ambiguous: [],
    });
    expect(source.reads).toEqual([]);
  });
});

describe("applyRelink", () => {
  it("rolls up as if the rows had named their thread all along, and changes nothing twice", async () => {
    const expected = database();
    ledger(expected, "after");
    const reference = rollup(expected);
    reference.catchUp();
    // The resume classification, which follows each session across hours, is part of what must match.
    expect(hourly(expected).some((row) => (row as { after_expiry: number }).after_expiry > 0)).toBe(true);

    const db = database();
    ledger(db, "before");
    const live = rollup(db);
    live.catchUp();
    expect(hourly(db)).not.toEqual(hourly(expected));

    expect(applyRelink(store(db), live.rollup, await planRelink(store(db), sources())).linkedRows).toBe(8);
    // s2, s3, s5 and the advisor row.
    expect(unlinkedRows(db)).toBe(4);
    expect(hourly(db)).toEqual([]);
    live.catchUp();
    expect(hourly(db)).toEqual(hourly(expected));

    const again = await planRelink(store(db), sources());
    expect(again.links).toEqual([]);
    expect(applyRelink(store(db), live.rollup, again).linkedRows).toBe(0);
    expect(hourly(db)).toEqual(hourly(expected));
  });

  it("leaves a session unlinked when another thread's row names it while the plan awaits BB", async () => {
    const db = database();
    ledger(db, "before");
    const plan = await planRelink(
      store(db),
      sources({
        // Requests finish while the plan reads roles: thr_b's names s1, and s4 gets a new row
        // the plan never read.
        role: async (threadId) => {
          if (threadId === "thr_a") {
            insert(db, { at: T0 + 200 * MINUTE, session: "s1", thread: "thr_b", role: "work" });
            insert(db, { at: T0 + 201 * MINUTE, session: "s4" });
          }
          return threadId === "thr_a" ? "work" : null;
        },
      }),
    );
    expect(plan.links.map((link) => link.sessionKey)).toContain("session:s1");

    const applied = applyRelink(store(db), rollup(db).rollup, plan);
    // s4's one planned row and codex-1's; none of s1's.
    expect(applied.linkedRows).toBe(2);
    expect(applied.plan.links.map((link) => link.sessionKey)).toEqual(["session:s4", "session:codex-1"]);
    expect(applied.plan.ambiguous).toContainEqual({
      sessionKey: "session:s1",
      provider: "claude",
      rows: 6,
      threadIds: ["thr_a", "thr_b"],
    });
    const threadsOf = (session: string) =>
      db
        .prepare("SELECT thread_id AS thread FROM usage_requests WHERE session_key = ? ORDER BY rowid")
        .all(`session:${session}`)
        .map((row) => (row as { thread: string | null }).thread);
    expect(threadsOf("s1")).toEqual([null, null, null, null, null, null, "thr_b"]);
    // The row that arrived after the plan read the ledger stays as it was.
    expect(threadsOf("s4")).toEqual(["thr_c", "thr_c", null]);
    expect(formatRelink(applied.plan, applied.linkedRows)).toContain(
      "  more than one thread claims the session: 8 rows in 3 sessions\n" +
        "    session:s2 (claude, 1 row): thr_a, thr_b\n" +
        "    session:s3 (claude, 1 row): thr_c, thr_d\n" +
        "    session:s1 (claude, 6 rows): thr_a, thr_b\n",
    );
  });
});

describe("recent sessions", () => {
  // A finished request the ledger has queued but not written, labelled with its thread.
  const queued = (session: string, startedAt: number): RequestRecord => ({
    kind: "native",
    provider: "claude",
    sessionKey: `session:${session}`,
    accountId: "acct-a",
    family: "opus",
    body: new TextEncoder().encode(JSON.stringify({ model: "claude-opus-5-5", messages: [] })),
    startedAt,
    finishedAt: startedAt + 1_000,
    status: 200,
    completed: true,
    usage: null,
  });

  it("skips a session active in the last 15 minutes, and lists it on a dry run", async () => {
    const db = database();
    ledger(db, "before");
    // s5's last request ended 14 minutes ago; s4's last 16 minutes ago.
    insert(db, { at: NOW - 14 * MINUTE - 1_000, session: "s5" });
    insert(db, { at: NOW - 16 * MINUTE - 1_000, session: "s4", thread: "thr_c", role: "adhoc" });
    const plan = await planRelink(store(db), sources());
    expect(plan.recent).toEqual([{ sessionKey: "session:s5", provider: "claude", rows: 2 }]);
    expect(plan.links.map((link) => link.sessionKey)).toContain("session:s4");
    expect(formatRelink(plan, null)).toContain(
      "  recent, skipped (active in the last 15 minutes; live linking labels them): 2 rows in 1 session\n",
    );
  });

  it("skips a session whose request the ledger still queues, behind more than one write batch", async () => {
    const db = database();
    ledger(db, "before");
    const usage = new UsageLedger({
      db,
      now: () => NOW,
      retentionDays: () => 30,
      thread: (key) => (key === "session:s1" ? { threadId: "thr_b", role: "work" } : null),
      log: () => undefined,
      // Never on its own: the queue stays as it is.
      defer: () => undefined,
    });
    const live: RelinkStore = { db, ledger: usage, now: () => NOW };
    const plan = await planRelink(
      live,
      sources({
        // While the plan awaits BB: 600 unrelated requests finish, then one of thr_b's in s1,
        // which started before the plan, 20 minutes ago.
        role: async (threadId) => {
          if (threadId === "thr_a") {
            for (let index = 0; index < 600; index += 1) usage.request(queued(`other-${index}`, NOW - MINUTE));
            usage.request(queued("s1", NOW - 20 * MINUTE));
          }
          return null;
        },
      }),
    );
    expect(plan.links.map((link) => link.sessionKey)).toContain("session:s1");
    // One flush writes the first 500; thr_b's request is still queued.
    usage.flush();
    expect(usage.queuedSessions().has("session:s1")).toBe(true);

    const applied = applyRelink(live, rollup(db).rollup, plan);
    expect(applied.plan.recent).toEqual([{ sessionKey: "session:s1", provider: "claude", rows: 6 }]);
    expect(applied.plan.links.map((link) => link.sessionKey)).toEqual(["session:s4", "session:codex-1"]);
    expect(applied.linkedRows).toBe(2);
    expect(unlinkedRows(db)).toBe(12 - 2 + 500);
  });

  it("skips a session that a written request made recent while the plan awaited BB", async () => {
    const db = database();
    ledger(db, "before");
    const plan = await planRelink(
      store(db),
      sources({
        role: async () => {
          insert(db, { at: NOW - MINUTE, session: "s1" });
          return null;
        },
      }),
    );
    const applied = applyRelink(store(db), rollup(db).rollup, plan);
    expect(applied.plan.recent).toEqual([{ sessionKey: "session:s1", provider: "claude", rows: 6 }]);
    expect(applied.linkedRows).toBe(2);
  });

  it("links nothing when the ledger dropped a request while the plan awaited BB", async () => {
    const db = database();
    ledger(db, "before");
    let dropped = 0;
    const health = () => ({ since: 0, rowsWritten: 0, writeErrors: 0, busyRetries: 0, dropped, lastError: null });
    const plan = await planRelink(
      store(db, { status: health }),
      sources({
        role: async () => {
          dropped = 1;
          return null;
        },
      }),
    );
    expect(() => applyRelink(store(db, { status: health }), rollup(db).rollup, plan)).toThrow("nothing was linked");
    expect(unlinkedRows(db)).toBe(12);
  });
});

describe("applyRelink and the live edge", () => {
  it("serves the relinked threads at once when every row is still live", async () => {
    const db = database();
    insert(db, { at: T0, session: "s1" });
    insert(db, { at: T0 + MINUTE, session: "s1" });
    // 20 minutes on: past relink's 15 minutes, but nothing is final for the rollup (30), so its
    // cursor stays at zero and it holds no row.
    const { rollup: r } = rollup(db, T0 + 20 * MINUTE);
    const byThread = () =>
      r
        .stats(
          usageStatsInputSchema.parse({ from: 0, to: T0 + 60 * MINUTE, bucket: null, filter: {}, groups: [["thread"]] }),
        )
        .results[0]!.map((row) => [row.key.thread, row.metrics.requests]);
    expect(byThread()).toEqual([[null, 2]]);
    const at = store(db, {}, T0 + 20 * MINUTE);
    expect(applyRelink(at, r, await planRelink(at, sources())).linkedRows).toBe(2);
    expect(byThread()).toEqual([["thr_a", 2]]);
  });
});

describe("formatRelink", () => {
  it("lists every ambiguous session and its claimants on a dry run", async () => {
    const db = database();
    ledger(db, "before");
    expect(formatRelink(await planRelink(store(db), sources()), null)).toBe(
      [
        "Rows with no thread: 11 rows in 6 sessions (claude 10, codex 1)",
        "  linkable, one thread reports the session: 8 rows in 3 sessions (claude 7, codex 1), 3 threads",
        "  no thread reports the session: 1 row in 1 session",
        "  more than one thread claims the session: 2 rows in 2 sessions",
        "    session:s2 (claude, 1 row): thr_a, thr_b",
        "    session:s3 (claude, 1 row): thr_c, thr_d",
        "Dry run: nothing changed. Run again with --apply to link them.",
      ].join("\n"),
    );
  });
});
