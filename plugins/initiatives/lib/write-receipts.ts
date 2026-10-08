import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { ProjectError } from "./bb";
import { WRITE_RECEIPT_MS, type WriteAnswer } from "./write-timeout";

/**
 * W248: the server's half of sendWrite. Each keyed write runs once; a send of the same key
 * gets the first run's answer from its receipt. Receipts live in the plugin database, so a
 * reload keeps them, and stay a day past the client's WRITE_RECEIPT_MS, for clock skew.
 *
 * state: running (answer null), done (answer: the JSON answer), rejected (answer: the refusal;
 * nothing was saved), failed (answer: the error; what it saved is unknown).
 */
export const WRITE_RECEIPT_MIGRATIONS = [
  `CREATE TABLE write_receipts (
    key TEXT PRIMARY KEY,
    project_id TEXT,
    command TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL,
    answer TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX write_receipts_created ON write_receipts(created_at)`,
];
export const WRITE_RECEIPT_KEEP_MS = WRITE_RECEIPT_MS + 24 * 60 * 60_000;

export const KEY_REUSED_MESSAGE = "This send's key belongs to a different request, so nothing was saved. Send it again.";
const unknown = (error: string) =>
  `${error.replace(/\.?$/, ".")} It is unclear what this saved: check the Initiative, then send it again if it is missing.`;

/** Key order does not matter: the same command is the same request. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]))
  : value;
const fingerprint = (command: unknown) => createHash("sha256").update(JSON.stringify(canonical(command))).digest("hex");

type Row = { project_id: string | null; command: string; fingerprint: string; state: string; answer: string | null };

export class WriteReceipts {
  /** This process's writes still running, so a repeat joins its answer. */
  private running = new Map<string, Promise<WriteAnswer>>();
  constructor(
    private readonly db: Database.Database,
    /** The database's change counter: unchanged across a refusal proves it saved nothing. */
    private readonly changes: () => number,
    private readonly now: () => number = Date.now,
  ) {}

  run(key: string, request: { projectId?: string; command: { action: string } }, write: () => Promise<unknown>): Promise<WriteAnswer> {
    this.db.prepare(`DELETE FROM write_receipts WHERE created_at < ?`).run(this.now() - WRITE_RECEIPT_KEEP_MS);
    const projectId = request.projectId ?? null;
    const print = fingerprint(request.command);
    const row = this.db.prepare(`SELECT project_id, command, fingerprint, state, answer FROM write_receipts WHERE key = ?`).get(key) as Row | undefined;
    if (row) {
      if (row.project_id !== projectId || row.command !== request.command.action || row.fingerprint !== print)
        return Promise.resolve({ write: "rejected", message: KEY_REUSED_MESSAGE });
      const joined = this.running.get(key);
      if (joined) return joined;
      if (row.state === "done") return Promise.resolve({ write: "done", answer: JSON.parse(row.answer ?? "null") });
      if (row.state === "rejected") return Promise.resolve({ write: "rejected", message: row.answer ?? "" });
      // failed, or running in a process that has since stopped.
      const error = row.state === "failed" ? row.answer ?? "The write failed." : "The plugin restarted while this write ran.";
      if (row.state !== "failed") this.settle(key, "failed", error);
      return Promise.resolve({ write: "unknown", message: unknown(error) });
    }
    this.db
      .prepare(`INSERT INTO write_receipts (key, project_id, command, fingerprint, state, created_at) VALUES (?, ?, ?, ?, 'running', ?)`)
      .run(key, projectId, request.command.action, print, this.now());
    const before = this.changes();
    const answer = (async (): Promise<WriteAnswer> => {
      try {
        const value = await write();
        this.settle(key, "done", JSON.stringify(value ?? null));
        return { write: "done", answer: value ?? null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A deliberate refusal before anything was written proves no effect. Anything else
        // (a native call failing, a refusal after a write) leaves the client holding its key.
        if (error instanceof ProjectError && this.changes() === before) {
          this.settle(key, "rejected", message);
          return { write: "rejected", message };
        }
        this.settle(key, "failed", message);
        throw error;
      } finally {
        this.running.delete(key);
      }
    })();
    this.running.set(key, answer);
    return answer;
  }

  private settle(key: string, state: "done" | "rejected" | "failed", answer: string) {
    this.db.prepare(`UPDATE write_receipts SET state = ?, answer = ? WHERE key = ?`).run(state, answer, key);
  }
}
