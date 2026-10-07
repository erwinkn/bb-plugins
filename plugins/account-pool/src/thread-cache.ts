import type Database from "better-sqlite3";
import { z } from "zod";
import { CACHE_TTL_MS, type CacheTtl } from "./cache-usage.js";

// How large a thread's cached prompt is and until when its cache entry lives, for Initiatives to
// ask before it gives more work to an idle worker (T142). It comes from the usage ledger: the
// main conversation's latest successful native request and refresh in the thread's current Claude
// Code session; and from the warmer's live lease. The main conversation is the latest native
// request with a prefix of at least MAIN_PREFIX_TOKENS: helpers (titles, summaries, small
// subagents) sent after it are smaller. A session with no such request reports its latest one,
// which is small. Nothing here sends a request.

const MAIN_PREFIX_TOKENS = 50_000;
const RECENT_ROWS = 100;

export const threadCacheStateInputSchema = z
  .object({ threadIds: z.array(z.string().min(1).max(200)).min(1).max(50) })
  .strict();

export const threadCacheSchema = z
  .object({
    sessionId: z.string(),
    model: z.string().nullable(),
    // Start of the session's latest successful native request on that model.
    lastRequestAt: z.number().int(),
    // Cache read + cache write of the latest request that read or wrote the entry.
    prefixTokens: z.number().int(),
    ttl: z.enum(["5m", "1h"]),
    // The entry lives until then: the latest native or refresh start + TTL, or a live lease's.
    coveredUntil: z.number().int(),
    leased: z.boolean(),
  })
  .strict();
export type ThreadCache = z.infer<typeof threadCacheSchema>;

export const threadCacheStateSchema = z
  .object({
    threads: z.array(
      z
        .object({
          threadId: z.string(),
          // null: the thread has no Claude session, or no successful request of it was recorded.
          cache: threadCacheSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type ThreadCacheState = z.infer<typeof threadCacheStateSchema>;

export interface ThreadCacheDeps {
  db: Database.Database;
  // The thread's current Claude Code session (BB's thread/identity record), or null.
  session: (threadId: string) => Promise<string | null>;
  lease: (sessionId: string) => { model: string | null; coveredUntil: number } | null;
}

// A session's latest successful native requests and refreshes, newest first, through the
// (session_key, at) index: a bounded read whatever the session's history.
export const CACHE_ROWS_SQL = `SELECT model, kind, ttl, at, cache_read_tokens, cache_write_tokens
  FROM usage_requests
  WHERE session_key = ? AND provider = 'claude' AND kind IN ('native', 'refresh')
    AND status BETWEEN 200 AND 299 AND cache_read_tokens IS NOT NULL
  ORDER BY at DESC LIMIT ${RECENT_ROWS}`;

interface CacheRow {
  model: string | null;
  kind: "native" | "refresh";
  ttl: CacheTtl | null;
  at: number;
  cache_read_tokens: number;
  cache_write_tokens: number | null;
}

export async function threadCacheState(
  deps: ThreadCacheDeps,
  threadIds: string[],
): Promise<ThreadCacheState> {
  const select = deps.db.prepare(CACHE_ROWS_SQL);
  const threads = await Promise.all(
    [...new Set(threadIds)].map(async (threadId) => {
      const sessionId = await deps.session(threadId).catch(() => null);
      const cache =
        sessionId === null
          ? null
          : sessionCache(
              sessionId,
              select.all(`session:${sessionId}`) as CacheRow[],
              deps.lease(sessionId),
            );
      return { threadId, cache };
    }),
  );
  return { threads };
}

const prefixOf = (row: CacheRow) => row.cache_read_tokens + (row.cache_write_tokens ?? 0);

// rows: newest first.
function sessionCache(
  sessionId: string,
  rows: CacheRow[],
  lease: { model: string | null; coveredUntil: number } | null,
): ThreadCache | null {
  const natives = rows.filter((row) => row.kind === "native");
  const main = natives.find((row) => prefixOf(row) >= MAIN_PREFIX_TOKENS) ?? natives[0];
  if (main === undefined) return null;
  const refresh = rows.find(
    (row) => row.kind === "refresh" && row.model === main.model && row.at > main.at,
  );
  const latest = refresh ?? main;
  const ttl = main.ttl ?? "5m";
  const leased = lease !== null && lease.model === main.model;
  return {
    sessionId,
    model: main.model,
    lastRequestAt: main.at,
    prefixTokens: prefixOf(latest),
    ttl,
    coveredUntil: Math.max(latest.at + CACHE_TTL_MS[ttl], leased ? lease.coveredUntil : 0),
    leased,
  };
}
