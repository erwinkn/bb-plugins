import type Database from "better-sqlite3";
import { UiCommandSchema, type UiAction, type UiActionResult, type UiCommand } from "./ui-actions.ts";

export const UI_COMMAND_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS voice_ui_commands (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, call_nonce TEXT NOT NULL, command_json TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_voice_ui_commands_call ON voice_ui_commands (conversation_id, call_nonce, state)`,
];
type Identity = { conversationId: string; callNonce: string };
type Row = { id: string; command_json: string; state: string; result_json: string | null };

/** Receipts survive disconnects. An effect whose execution started is never replayed. */
export class UiCommandManager {
  private waiters = new Map<string, { resolve: (result: UiActionResult) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private db: Database.Database, private active: (command: UiCommand) => boolean, private publish: (command: UiCommand) => void, private timeoutMs = 20_000, private revoke: (command: UiCommand) => void = () => {}, private callActive: (command: UiCommand) => boolean = active) {
    for (const row of this.db.prepare("SELECT * FROM voice_ui_commands WHERE state IN ('pending','started')").all() as Row[]) {
      this.finish(row.id, { status: row.state === "started" ? "unknown" : "cancelled", detail: "The plugin restarted before a result was received. The command will not run again." });
    }
  }
  private get(id: string): Row | undefined { return this.db.prepare("SELECT * FROM voice_ui_commands WHERE id = ?").get(id) as Row | undefined; }
  private finish(id: string, result: UiActionResult) {
    const row = this.get(id);
    if (!row || row.state === "done") return;
    this.db.prepare("UPDATE voice_ui_commands SET state = 'done', result_json = ? WHERE id = ? AND state != 'done'").run(JSON.stringify(result), id);
    if (result.status === "cancelled" || result.status === "unknown") {
      this.revoke(UiCommandSchema.parse(JSON.parse(row.command_json)));
    }
    const waiter = this.waiters.get(id);
    if (waiter) { clearTimeout(waiter.timer); this.waiters.delete(id); waiter.resolve(result); }
  }
  private matches(command: UiCommand, input: Identity): boolean {
    return command.conversationId === input.conversationId && command.callNonce === input.callNonce && this.active(command);
  }
  private expire(row: Row, command: UiCommand): boolean {
    if (command.expiresAt !== undefined && command.expiresAt <= Date.now()) {
      this.finish(row.id, { status: row.state === "started" ? "unknown" : "cancelled", detail: "No UI receipt arrived before the command expired. Do not assume it completed." });
      return true;
    }
    return false;
  }
  issue(input: Identity & { requestId: string; action: UiAction }, signal?: AbortSignal): Promise<UiActionResult> {
    const command = UiCommandSchema.parse({ ...input, id: crypto.randomUUID(), expiresAt: Date.now() + this.timeoutMs });
    if (signal?.aborted || !this.active(command)) return Promise.resolve({ status: "cancelled", detail: "The originating request or call is no longer active." });
    // Keep only bounded command metadata, independently of transcript retention.
    this.db.prepare("DELETE FROM voice_ui_commands WHERE state = 'done' AND id NOT IN (SELECT id FROM voice_ui_commands WHERE state = 'done' ORDER BY created_at DESC LIMIT 500)").run();
    const pending = this.db.prepare("SELECT COUNT(*) AS count FROM voice_ui_commands WHERE state != 'done'").get() as { count: number };
    if (pending.count >= 32) return Promise.resolve({ status: "failed", detail: "Too many UI commands are waiting for a result." });
    this.db.prepare("INSERT INTO voice_ui_commands (id, conversation_id, call_nonce, command_json, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").run(command.id, command.conversationId, command.callNonce, JSON.stringify(command), Date.now());
    return new Promise<UiActionResult>(resolve => {
      const cancel = () => {
        const started = this.get(command.id)?.state === "started";
        this.finish(command.id, { status: started ? "unknown" : "cancelled", detail: started ? "Execution started but the request ended before a result arrived." : "The request ended before UI execution." });
      };
      const timer = setTimeout(() => { const row = this.get(command.id); if (row) this.expire(row, command); }, this.timeoutMs);
      this.waiters.set(command.id, { timer, resolve: result => { signal?.removeEventListener("abort", cancel); resolve(result); } });
      signal?.addEventListener("abort", cancel, { once: true });
      try { this.publish(command); } catch { /* Owner recovers pending commands through RPC. */ }
    });
  }
  pending(input: Identity): UiCommand[] {
    const rows = this.db.prepare("SELECT * FROM voice_ui_commands WHERE conversation_id = ? AND call_nonce = ? AND state = 'pending' ORDER BY created_at").all(input.conversationId, input.callNonce) as Row[];
    return rows.flatMap(row => {
      const command = UiCommandSchema.parse(JSON.parse(row.command_json));
      return !this.expire(row, command) && this.matches(command, input) ? [command] : [];
    });
  }
  claim(input: Identity & { commandId: string }): { claimed: boolean; command?: UiCommand } {
    const row = this.get(input.commandId);
    if (!row || row.state !== "pending") return { claimed: false };
    const command = UiCommandSchema.parse(JSON.parse(row.command_json));
    if (this.expire(row, command) || !this.matches(command, input)) return { claimed: false };
    const changed = this.db.prepare("UPDATE voice_ui_commands SET state = 'started' WHERE id = ? AND state = 'pending'").run(row.id).changes;
    return changed ? { claimed: true, command } : { claimed: false };
  }
  report(input: Identity & { commandId: string; result: UiActionResult }): { accepted: boolean } {
    const row = this.get(input.commandId);
    if (!row) return { accepted: false };
    const command = UiCommandSchema.parse(JSON.parse(row.command_json));
    if (command.conversationId !== input.conversationId || command.callNonce !== input.callNonce || !this.callActive(command)) return { accepted: false };
    if (row.state === "done") return { accepted: row.result_json === JSON.stringify(input.result) };
    if (!this.active(command)) return { accepted: false };
    if (row.state !== "started" || this.expire(row, command)) return { accepted: false };
    this.finish(row.id, input.result);
    return { accepted: true };
  }
  revoked(input: Identity): string[] {
    const rows = this.db.prepare("SELECT * FROM voice_ui_commands WHERE conversation_id = ? AND call_nonce = ? AND state = 'done' ORDER BY created_at DESC LIMIT 500").all(input.conversationId, input.callNonce) as Row[];
    return rows.flatMap(row => {
      const result = row.result_json ? JSON.parse(row.result_json) as UiActionResult : null;
      return result?.status === "cancelled" || result?.status === "unknown" ? [row.id] : [];
    });
  }
  cancelRequest(requestId: string) {
    for (const row of this.db.prepare("SELECT * FROM voice_ui_commands WHERE state != 'done'").all() as Row[]) {
      const command = UiCommandSchema.parse(JSON.parse(row.command_json));
      if (command.requestId === requestId) this.finish(row.id, { status: row.state === "started" ? "unknown" : "cancelled", detail: "The originating request ended. No further UI action is permitted." });
    }
  }
  cancelCall(callNonce: string) {
    for (const row of this.db.prepare("SELECT * FROM voice_ui_commands WHERE call_nonce = ? AND state != 'done'").all(callNonce) as Row[]) {
      this.finish(row.id, { status: row.state === "started" ? "unknown" : "cancelled", detail: "The voice call ended. No further UI action is permitted." });
    }
  }
  dispose() {
    for (const row of this.db.prepare("SELECT * FROM voice_ui_commands WHERE state != 'done'").all() as Row[]) {
      this.finish(row.id, { status: row.state === "started" ? "unknown" : "cancelled", detail: "Voice Mode stopped before a result was received." });
    }
  }
}
