import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Thread, Watches } from "./watches.ts";
import { isHistoricalAgentThread } from "./history-boundary.ts";

export const LEGACY_WATCH_IMPORT_KEY = "voice.legacy-watch-import.v1";

export function isLegacyCoordinator(watches: Watches, thread: Thread) {
  return isHistoricalAgentThread(watches.store.db, thread.id) ||
    (thread.title ?? thread.titleFallback ?? "").startsWith("Voice coordinator ");
}

/** Import ownership and subscriptions once without replaying old thread results. */
export async function importLegacyWatches(bb: BbPluginApi, watches: Watches) {
  if (await bb.storage.kv.get<boolean>(LEGACY_WATCH_IMPORT_KEY)) return;
  const db = watches.store.db;
  const exists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  type LegacyWorker = { request_id: string; step: number; conversation_id: string; thread_id: string | null;
    role: string; title: string; status: string; created_at: number };
  const subscriptions = exists("voice_watch") ? db.prepare("SELECT conversation_id, thread_id FROM voice_watch WHERE removed_at IS NULL").all() as {conversation_id: string; thread_id: string}[] : [];
  const workers = exists("voice_workers") ? db.prepare("SELECT * FROM voice_workers WHERE status IN ('creating','active','unknown')").all() as LegacyWorker[] : [];
  const loaded = new Map<string, { thread: Thread; root: string; cursor: number; text: string | null } | null>();
  async function load(id: string) {
    if (loaded.has(id)) return loaded.get(id)!;
    let thread: Thread;
    try { thread = await bb.sdk.threads.get({ threadId: id }); }
    catch (error) {
      const failure = error as { status?: number; statusCode?: number } | null;
      const status = failure?.status ?? failure?.statusCode;
      if (status !== 404 && !/not found|does not exist|missing thread/i.test(String(error))) throw error;
      loaded.set(id, null); return null;
    }
    // Archived or deleted threads are finished; importing them would only announce their archive.
    if (thread.deletedAt || thread.archivedAt || isLegacyCoordinator(watches, thread)) { loaded.set(id, null); return null; }
    const root = await watches.root(thread);
    const [latest] = await bb.sdk.threads.events.list({ threadId: id, order: "desc", limit: "1" });
    const output = await bb.sdk.threads.output({ threadId: id });
    const value = { thread, root, cursor: latest?.seq ?? 0, text: output.output };
    loaded.set(id, value); return value;
  }
  for (const id of new Set([...subscriptions.map(row => row.thread_id), ...workers.flatMap(row => row.thread_id ? [row.thread_id] : [])])) await load(id);
  const at = watches.store.now();
  const insertWatch = db.prepare(`INSERT OR IGNORE INTO voice_watches
    (conversation_id,thread_id,root_thread_id,state,cursor_seq,last_status,last_text,created_at,updated_at)
    VALUES (?,?,?,'active',?,?,?,?,?)`);
  const insertTask = db.prepare(`INSERT OR IGNORE INTO voice_tasks
    (op_id,conversation_id,thread_id,kind,profile,title,status,last_text,created_at,updated_at)
    VALUES (?,?,?,'worker',?,?,?,?,?,?)`);
  db.transaction(() => {
    for (const row of subscriptions) {
      const data = loaded.get(row.thread_id);
      if (data) insertWatch.run(row.conversation_id, row.thread_id, data.root, data.cursor, data.thread.status, data.text, at, at);
    }
    for (const row of workers) {
      // A worker without a thread id cannot be resolved by the new runtime and would hold a slot forever.
      const data = row.thread_id ? loaded.get(row.thread_id) : null;
      if (!row.thread_id || !data) continue;
      const id = `legacy:${row.request_id}:${row.step}`;
      insertTask.run(id, row.conversation_id, row.thread_id, row.role, row.title,
        row.status === "active" ? "running" : "unknown", data.text, row.created_at, at);
      insertWatch.run(row.conversation_id, row.thread_id, data.root, data.cursor, data.thread.status, data.text, at, at);
    }
  })();
  // If this write fails, INSERT OR IGNORE makes the next startup safe to retry.
  await bb.storage.kv.set(LEGACY_WATCH_IMPORT_KEY, true);
}
