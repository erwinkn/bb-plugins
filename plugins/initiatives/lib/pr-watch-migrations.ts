// W548: PR watches' tables, apart from pr-watch.ts so the store (which the dashboard bundle
// reaches) imports no server code.
export const PR_WATCH_MIGRATIONS = [
  // W548: each watched PR's last seen state (WatchState as JSON; NULL before its baseline) and
  // mute. `since`: changes after this are news. `gen` moves on each mute and unmute: a pass or a
  // wake from before it no longer applies. The previous build ignores both tables.
  `CREATE TABLE pr_watches (
    url TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    node_id TEXT,
    muted INTEGER NOT NULL DEFAULT 0,
    since INTEGER NOT NULL,
    state TEXT,
    gen INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  // W548: each wake, written with the state that found it and sent after: pending, sending, then
  // sent, stale, muted, failed or uncertain (a reload cut its send short; never sent again).
  // `head`: the head its watch read saw; `gen`: its watch's generation then; `refusals`: sends BB
  // refused, each back to pending (WAKE_REFUSALS).
  `CREATE TABLE pr_wakes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    url TEXT NOT NULL,
    worker TEXT,
    head TEXT NOT NULL,
    pr TEXT NOT NULL,
    changes TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    gen INTEGER NOT NULL,
    state TEXT NOT NULL,
    sent_at INTEGER,
    routed TEXT,
    refusals INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX pr_wakes_state ON pr_wakes(state, id)`,
  `CREATE INDEX pr_wakes_url ON pr_wakes(url, id)`,
  // W554: watches are explicit (initiative_pr_watch). `watcher_thread_id`: the thread that watches
  // the PR, NULL when nobody does (unwatched, or a W548 row made from ownership). An unwatch also
  // sets `muted`, so the previous build leaves that PR alone. A wake's `thread_id`: the
  // watcher it was found for. The previous build ignores both columns.
  `ALTER TABLE pr_watches ADD COLUMN watcher_thread_id TEXT`,
  `ALTER TABLE pr_wakes ADD COLUMN thread_id TEXT`,
];
